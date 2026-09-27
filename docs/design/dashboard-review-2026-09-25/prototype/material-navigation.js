/* Preserve existing navigation actions while adding complete tab keyboard behavior. */
(function () {
  "use strict";
  let bound = false;
  function sync(root) {
    for (const navigation of root.querySelectorAll(".ar-tabs,.ar-group")) {
      const tabs = Array.from(navigation.children).filter((node) =>
        node.matches("button[data-action]"),
      );
      if (!tabs.length) continue;
      const selected = tabs.find((tab) => tab.getAttribute("aria-current") === "page") || tabs[0];
      const prefix = tabs[0].dataset.action
        .split(":")
        .slice(0, -1)
        .join("-")
        .replace(/[^A-Za-z0-9_-]/g, "-");
      navigation.id ||= "ar-tablist-" + prefix;
      navigation.setAttribute("role", "tablist");
      navigation.setAttribute("aria-orientation", "horizontal");
      if (!navigation.hasAttribute("aria-label"))
        navigation.setAttribute("aria-label", "Workspace pages");
      const panelId = navigation.id + "-panel";
      for (const tab of tabs) {
        tab.id ||= "ar-tab-" + tab.dataset.action.replace(/[^A-Za-z0-9_-]/g, "-");
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(tab === selected));
        tab.setAttribute("aria-controls", panelId);
        tab.tabIndex = tab === selected ? 0 : -1;
      }
      let panel = navigation.nextElementSibling;
      if (!panel?.classList.contains("ar-material-tab-panel")) {
        const children = [];
        for (let sibling = navigation.nextSibling; sibling; sibling = sibling.nextSibling)
          children.push(sibling);
        panel = document.createElement("div");
        panel.className = "ar-material-tab-panel";
        navigation.after(panel);
        panel.append(...children);
      }
      panel.id = panelId;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", selected.id);
    }
    for (const chip of root.querySelectorAll(".ar-pills>button")) {
      if (!chip.querySelector(":scope>.ar-filter-check")) {
        const marker = document.createElement("span");
        marker.className = "ar-filter-check";
        marker.setAttribute("aria-hidden", "true");
        marker.innerHTML = '<i data-lucide="check" aria-hidden="true"></i>';
        chip.prepend(marker);
      }
    }
    if (!bound) {
      root.addEventListener("keydown", (event) => {
        const tab = event.target.closest('[role="tab"]');
        const navigation = tab?.parentElement;
        if (
          !navigation?.matches('[role="tablist"]') ||
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        )
          return;
        const tabs = Array.from(
          navigation.querySelectorAll(':scope>button[role="tab"]:not(:disabled)'),
        );
        if (!tabs.length) return;
        const current = tabs.indexOf(tab),
          rtl = getComputedStyle(navigation).direction === "rtl";
        const step = (event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (current + step + tabs.length) % tabs.length;
        event.preventDefault();
        tabs.forEach((button) => {
          button.tabIndex = button === tabs[next] ? 0 : -1;
        });
        tabs[next].focus({ preventScroll: true });
        tabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
      });
      bound = true;
    }
  }
  globalThis.ARMaterialNavigation = { sync };
})();
