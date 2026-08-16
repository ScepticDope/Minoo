// # Toast and confirm dialogs.

let toastTimer = null;

// ## Show a short-lived message toast, mostly used for errors.
export function showToast(message) {
  document.getElementById("toast-message").textContent = `${message}`;
  document.getElementById("toast").classList.add("active");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => document.getElementById("toast").classList.remove("active"),
    5000,
  );
}

// ## Ask for confirmation with the #confirm dialog, resolving to the user's answer.
// The explicit Promise turns the user choice into a value callers
// can simply await, like the native confirm().
export function appConfirm(message, okText = "Confirm") {
  return new Promise((resolve) => {
    const confirmModal = document.getElementById("confirm");
    const previousFocus = document.activeElement;

    document.getElementById("confirm-message").textContent = message;
    document.getElementById("confirm-ok").textContent = okText;
    confirmModal.classList.add("active");

    document.getElementById("confirm-cancel").focus();

    // The arrow keys and Tab hop between the two answers, and Enter picks the
    // focused one through the button's own key handling.
    const onKeydown = (event) => {
      const hops = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];
      if (!hops.includes(event.key)) return;

      event.preventDefault();

      const cancel = document.getElementById("confirm-cancel");
      const ok = document.getElementById("confirm-ok");

      (document.activeElement === cancel ? ok : cancel).focus();
    };
    confirmModal.addEventListener("keydown", onKeydown);

    const finish = (answer) => {
      confirmModal.classList.remove("active");
      confirmModal.removeEventListener("keydown", onKeydown);

      previousFocus?.focus?.();

      resolve(answer);
    };

    document.getElementById("confirm-ok").onclick = () => finish(true);
    document.getElementById("confirm-cancel").onclick = () => finish(false);
    document.getElementById("confirm-bg").onclick = () => finish(false);
  });
}
