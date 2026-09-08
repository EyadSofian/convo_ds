const header = document.querySelector('[data-header]');
const pageProgress = document.querySelector('[data-page-progress]');
const journey = document.querySelector('#journey');
const journeyProgress = document.querySelector('[data-journey-progress]');
const revealItems = [...document.querySelectorAll('.reveal')];
const navLinks = [...document.querySelectorAll('.site-header nav a')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const updateScrollState = () => {
  header?.classList.toggle('is-scrolled', window.scrollY > 18);

  const max = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
  if (pageProgress) pageProgress.style.width = `${ratio * 100}%`;

  if (journey && journeyProgress) {
    const rect = journey.getBoundingClientRect();
    const travel = journey.offsetHeight - window.innerHeight;
    const progress = travel > 0 ? Math.min(Math.max(-rect.top / travel, 0), 1) : 0;
    journeyProgress.style.width = `${progress * 100}%`;
  }
};

updateScrollState();
window.addEventListener('scroll', updateScrollState, { passive: true });
window.addEventListener('resize', updateScrollState, { passive: true });

if ('IntersectionObserver' in window && !reducedMotion) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -7% 0px' },
  );
  revealItems.forEach((item) => revealObserver.observe(item));

  ['.operation-flow', '[data-day-map]'].forEach((selector) => {
    const target = document.querySelector(selector);
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry], instance) => {
        if (!entry?.isIntersecting) return;
        target.classList.add('is-visible');
        instance.disconnect();
      },
      { threshold: 0.28 },
    );
    observer.observe(target);
  });
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
  document.querySelector('.operation-flow')?.classList.add('is-visible');
  document.querySelector('[data-day-map]')?.classList.add('is-visible');
}

const counter = document.querySelector('[data-count]');
if (counter) {
  const target = Number(counter.dataset.count ?? '10');
  if (reducedMotion) {
    counter.textContent = String(target);
  } else {
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - started) / 900, 1);
      counter.textContent = String(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

if ('IntersectionObserver' in window) {
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => {
        link.classList.toggle('is-active', link.getAttribute('href') === `#${visible.target.id}`);
      });
    },
    { threshold: [0.12, 0.28, 0.5], rootMargin: '-12% 0px -56% 0px' },
  );
  document.querySelectorAll('section[id]').forEach((section) => sectionObserver.observe(section));
}

const summary = [
  'CONVO — ملخص نطاق التنفيذ',
  'تجهيز مساحة مستقلة داخل المنصة وربط WhatsApp وFacebook وInstagram والموقع والـCRM الحالي.',
  'يشمل: المستخدمين والصلاحيات وعزل الـInboxes، Inbox، الفلاتر والتعيين، Contacts، Broadcasts والتقارير.',
  'التنفيذ: 12 يوم عمل، تشمل الاختبار الوظيفي وUAT لإطلاق الـMVP.',
  'المطلوب: مسؤول اعتماد، بيانات الفريق، حسابات Meta، قواعد التشغيل، والجمهور والقوالب.',
  'التكلفة: 700 دولار مرة واحدة + تقدير 30–40 دولار شهريًا للاستضافة.',
  'الدفع: 40% عند البدء، 30% بعد اعتماد النسخة التشغيلية، 30% عند التسليم النهائي.',
  'لا توجد رسوم لكل مستخدم. رسوم Meta وWhatsApp على العميل.',
].join('\n');

const copyButton = document.querySelector('[data-copy-summary]');
const toast = document.querySelector('[data-toast]');
let toastTimer;

copyButton?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(summary);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = summary;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  if (!toast) return;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
});
