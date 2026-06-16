(function () {
  var theme = "dark";
  try {
    if (localStorage.getItem("tobevpn_theme") === "light") {
      theme = "light";
    }
  } catch (_) {
    theme = "dark";
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
