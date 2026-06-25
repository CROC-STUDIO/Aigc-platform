// Lightweight, self-contained scroll-spy for the vertical pipeline step bar.
// No dependencies; safe to load on any page that has .wz-stepbar + .wz-step.
(() => {
  const stepbar = document.querySelector(".wz-stepbar");
  const steps = [...document.querySelectorAll(".wz-step")];
  if (!stepbar || !steps.length) return;

  const items = [...stepbar.querySelectorAll(".wz-stepbar-item")];
  const byStep = new Map();
  for (const item of items) byStep.set(item.dataset.step, item);

  function setActive(stepId) {
    for (const step of steps) {
      const item = byStep.get(step.dataset.step);
      const isActive = step.id === stepId;
      step.classList.toggle("active", isActive);
      if (item) item.classList.toggle("active", isActive);
    }
  }

  // Smooth scroll on click (respects scroll-margin-top from CSS).
  for (const item of items) {
    item.addEventListener("click", (event) => {
      const href = item.getAttribute("href") || "";
      const target = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", href);
    });
  }

  // Highlight whichever step is most prominently in view.
  if ("IntersectionObserver" in window) {
    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.intersectionRatio);
          else visible.delete(entry.target.id);
        }
        let best = null;
        let bestRatio = -1;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: "-120px 0px -55% 0px", threshold: [0.1, 0.25, 0.5, 0.75] }
    );
    for (const step of steps) observer.observe(step);
  }

  // Initial state.
  setActive(steps[0].id);
})();
