#!/bin/sh
# # Update the vendored CodeMirror bundle.
# CodeMirror is the one frontend dependency that cannot be a plain file, so it ships as
# src/js/codemirror.js: a single minified ES module. This script asks npm what the
# newest releases are and rebuilds that file from them, so upgrading never has to be
# done by hand.
#
#   ../update-codemirror.sh          Check for newer releases, then offer to rebuild.
#   ../update-codemirror.sh --check  Only report what is new, change nothing.
#   ../update-codemirror.sh --force  Rebuild, even when everything is up to date.
#
# Needs npm, which nothing but this script uses.

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bundle="$project_dir/src/js/codemirror.js"
editor="$project_dir/src/js/editor.js"

# ## The packages the bundle is built from, and what it re-exports from each.
# This is the one place to edit when the editor starts using another CodeMirror feature.
# The rebuild checks the result against what editor.js actually imports.
packages="@codemirror/commands @codemirror/lang-markdown @codemirror/language @codemirror/state @codemirror/view @lezer/highlight"

entry_file() {
  cat <<'ENTRY'
export { defaultKeymap, history, historyKeymap, indentLess, insertTab, redo, selectAll, undo } from "@codemirror/commands";
export { markdown, markdownLanguage } from "@codemirror/lang-markdown";
export { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
export { Compartment, EditorState } from "@codemirror/state";
export { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { styleTags, tags } from "@lezer/highlight";
ENTRY
}

# ## Read a package's version out of the bundle's header.
bundled_version() {
  sed -n "s|^//   $1 \\(.*\\)$|\\1|p" "$bundle" | head -1
}

# ## Ask npm for a package's newest release.
latest_version() {
  npm view "$1" version 2>/dev/null || true
}

# ## Report every package's bundled version next to its newest one.
# Returns 0 when something is out of date, so the caller can offer a rebuild.
check_versions() {
  outdated=0

  printf '%-28s %-12s %s\n' "Package" "Bundled" "Latest"

  for package in $packages; do
    have=$(bundled_version "$package")
    want=$(latest_version "$package")

    if [ -z "$want" ]; then
      printf '%-28s %-12s %s\n' "$package" "${have:-?}" "could not reach npm"
      continue
    fi

    if [ "$have" = "$want" ]; then
      printf '%-28s %-12s %s\n' "$package" "$have" "up to date"
    else
      printf '%-28s %-12s %s\n' "$package" "${have:-?}" "$want  <- new"
      outdated=1
    fi
  done

  [ "$outdated" = 1 ]
}

# ## List the names editor.js imports from the bundle.
# Both the wrapped and the single line form of the import are read, so reformatting
# editor.js cannot quietly disable the check below.
imported_names() {
  tr '\n' ' ' <"$editor" |
  sed -n 's|.*import[[:space:]]*{\([^}]*\)}[[:space:]]*from[[:space:]]*"\./codemirror\.js".*|\1|p' |
  tr ',' '\n' |
  sed 's|[[:space:]]||g' |
  grep -v '^$'
}

# ## List the names a built bundle exports.
exported_names() {
  grep -o 'export{[^}]*}' "$1" |
  tr ',' '\n' |
  sed 's|.*as ||; s|export{||; s|}||' |
  grep -v '^$'
}

# ## Build a new bundle and put it in place.
rebuild() {
  work=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  echo
  echo "Installing the packages..."
  (
  cd "$work"
  npm init -y >/dev/null 2>&1
  # shellcheck disable=SC2086
  npm install --silent --no-audit --no-fund $packages esbuild >/dev/null
  )

  echo "Bundling..."
  entry_file >"$work/entry.js"
  (
  cd "$work"
  npx esbuild entry.js \
    --bundle \
    --format=esm \
    --minify \
    --target=safari15 \
    --legal-comments=none \
    --log-level=warning \
    --outfile=built.js
  )

  # The bundle is only useful if it still exports everything editor.js imports.
  missing=""
  exported_names "$work/built.js" >"$work/exported"
  for name in $(imported_names); do
    grep -qx "$name" "$work/exported" || missing="$missing $name"
  done

  if [ -z "$(imported_names)" ]; then
    echo "Could not read editor.js's import list, so the new bundle stays unused." >&2
    exit 1
  fi

  if [ -n "$missing" ]; then
    echo "The new bundle is missing:$missing" >&2
    echo "Add them to this script's entry_file, then run it again." >&2
    exit 1
  fi

  # A truncated bundle would still export the right names, so parse it as well.
  cp "$work/built.js" "$work/built.mjs"
  node --check "$work/built.mjs"

  # ## Write the header, with the versions npm actually installed.
  {
    cat <<'HEADER'
// # CodeMirror 6, bundled for Minoo.
// The whole library in one minified ES module. Created by update-codemirror.sh.
//
// **Never manually edit this file.**
//
// Bundled versions:
HEADER
    for package in $packages; do
      printf '//   %s %s\n' "$package" \
        "$(node -p "require('$work/node_modules/$package/package.json').version")"
    done
    cat <<'FOOTER'
//
// MIT License - https://code.haverbeke.berlin/codemirror/dev/src/branch/main/LICENSE
//
// Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin>, Adrian Heine <mail@adrianheine.de>, and others

FOOTER
    cat "$work/built.js"
  } >"$work/codemirror.js"

  was=$(wc -c <"$bundle" | tr -d ' ')
  now=$(wc -c <"$work/codemirror.js" | tr -d ' ')

  mv "$work/codemirror.js" "$bundle"

  echo
  echo "Wrote src/js/codemirror.js, $((was / 1024)) KB -> $((now / 1024)) KB."
  echo "Run the app to check the editor before committing."
}

# ## Run it.
case "${1:-}" in
  --check)
    check_versions || true
  ;;
  --force)
    check_versions || true
    rebuild
  ;;
  "")
    if check_versions; then
      echo
      printf 'Build a new bundle from the latest releases? [y/N] '
      read -r answer
      case "$answer" in
        [yY]*) rebuild ;;
        *) echo "Left src/js/codemirror.js alone." ;;
      esac
    else
      echo
      echo "The bundle is up to date. Use --force to rebuild it anyway."
    fi
  ;;
  *)
    echo "Usage: $0 [--check | --force]" >&2
    exit 1
  ;;
esac
