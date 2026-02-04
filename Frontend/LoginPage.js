const form = document.getElementById("authForm");
const toggle = document.getElementById("toggleAuth");
const switchText = document.getElementById("switchText");
const btnText = document.querySelector(".btn-text");
const loader = document.querySelector(".loader");
const container = document.querySelector(".auth-container");
const googleBtn = document.getElementById("googleLogin");

let isSignup = false;

/* TOGGLE SIGN IN / SIGN UP */
toggle.addEventListener("click", (e) => {
  e.preventDefault();
  isSignup = !isSignup;

  container.classList.toggle("signup");
  btnText.textContent = isSignup ? "Sign Up" : "Sign In";
  switchText.textContent = isSignup
    ? "Already have an account?"
    : "Don’t have an account?";
  toggle.textContent = isSignup ? "Sign in" : "Create one";
});

/* FORM SUBMIT */
form.addEventListener("submit", (e) => {
  e.preventDefault();

  btnText.style.display = "none";
  loader.style.display = "inline-block";

  let name = "User";

  if (isSignup) {
    const nameInput = form.querySelector('input[type="text"]');
    if (nameInput && nameInput.value.trim()) {
      name = nameInput.value.trim();
    }
  }

  setTimeout(() => {
    localStorage.setItem("focusflow_logged_in", "true");
    localStorage.setItem(
      "focusflow_user",
      JSON.stringify({ name })
    );
    window.location.href = "index.html";
  }, 800);
});

/* GOOGLE LOGIN (SIMULATED) */
googleBtn.addEventListener("click", () => {
  const name = prompt("Enter your name");
  localStorage.setItem("focusflow_logged_in", "true");
  localStorage.setItem(
    "focusflow_user",
    JSON.stringify({ name: name || "User" })
  );
  window.location.href = "index.html";
});
