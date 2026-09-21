/* ============================================================
   FpEnhancer — Login page logic
   POST /login (JSON) -> HttpOnly session cookie set by the server.
   No credentials are ever stored in the browser.
   ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("loginForm");
  const userInput = $("username");
  const pwInput = $("password");
  const btn = $("loginBtn");
  const label = btn.querySelector(".auth__submit-label");
  const spinner = btn.querySelector(".auth__spinner");
  const errorBox = $("loginError");
  const notice = $("loginNotice");
  const togglePw = $("togglePw");

  // Friendly notice when redirected here after an idle timeout.
  try {
    const params = new URLSearchParams(location.search);
    const reason = params.get("reason");
    if (reason === "timeout") {
      notice.textContent = "You were signed out after 5 minutes of inactivity. Please sign in again.";
      notice.hidden = false;
    } else if (reason === "logout") {
      notice.textContent = "You have been signed out.";
      notice.hidden = false;
    }
    if (reason) history.replaceState(null, "", "/login");
  } catch (_) { /* ignore */ }

  function setBusy(busy) {
    btn.disabled = busy;
    userInput.disabled = busy;
    pwInput.disabled = busy;
    label.textContent = busy ? "Signing in…" : "Sign In";
    spinner.hidden = !busy;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
    form.classList.remove("auth__form--shake");
    // restart the shake animation
    void form.offsetWidth;
    form.classList.add("auth__form--shake");
  }

  togglePw.addEventListener("click", () => {
    const show = pwInput.type === "password";
    pwInput.type = show ? "text" : "password";
    togglePw.setAttribute("aria-pressed", String(show));
    togglePw.setAttribute("aria-label", show ? "Hide password" : "Show password");
    pwInput.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    notice.hidden = true;

    const username = userInput.value.trim();
    const password = pwInput.value;

    if (!username || !password) {
      showError("Please enter both username and password.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        // Clear the field from memory ASAP; the cookie is HttpOnly.
        pwInput.value = "";
        location.replace("/");
        return;
      }

      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) { /* ignore */ }

      if (res.status === 401) showError("Invalid username or password.");
      else if (res.status === 429) showError(detail || "Too many failed attempts. Please wait and try again.");
      else if (res.status === 503) showError(detail || "Login is not configured on the server.");
      else showError(detail || `Sign in failed (HTTP ${res.status}).`);
    } catch (_) {
      showError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
      pwInput.value = "";
    }
  });

  userInput.focus();
})();
