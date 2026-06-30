// app/social.js
// DOM-free helpers: derive a display name from an optional social URL so the
// composed preview can label speakers without a separate name field.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function trim(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function titleCase(value) {
    return trim(value)
      .split(/[\s-_]+/)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(" ");
  }

  function handleFromSocialUrl(url) {
    const text = trim(url);
    const twitter = text.match(/(?:twitter\.com|x\.com)\/([^/?#]+)/i);
    if (twitter) return titleCase(twitter[1].replace(/[_-]+/g, " "));
    const linkedin = text.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (linkedin) return titleCase(linkedin[1].replace(/[-_]+/g, " "));
    const instagram = text.match(/instagram\.com\/([^/?#]+)/i);
    if (instagram) return titleCase(instagram[1].replace(/[._-]+/g, " "));
    return "";
  }

  function displayNameForSocial(url, fallback) {
    return handleFromSocialUrl(url) || fallback || "";
  }

  PDC.social = {
    handleFromSocialUrl,
    displayNameForSocial,
  };
})();
