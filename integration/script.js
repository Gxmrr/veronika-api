// VERONIKA: календарь + свободные часы + ручной ввод времени.
// Не меняет другие части страницы: карту, футер, анимации и меню.
const API_BASE = "https://veronika-api-lashkovmaximik-g7tm.onreza.app";
const form = document.getElementById("booking-form");
const dateInput = document.getElementById("date");
const serviceInput = document.getElementById("service");
const phoneInput = document.getElementById("phone");
const message = document.getElementById("message");
const submitButton = form?.querySelector('[type="submit"]');

const oldTimeInput = document.getElementById("time");
let timeInput = oldTimeInput;
if (oldTimeInput && oldTimeInput.tagName === "SELECT") {
  const replacement = document.createElement("input");
  replacement.id = "time";
  replacement.name = oldTimeInput.name || "time";
  replacement.className = oldTimeInput.className;
  oldTimeInput.replaceWith(replacement);
  timeInput = replacement;
}

function dateInMoscow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

if (phoneInput) {
  phoneInput.type = "tel";
  phoneInput.inputMode = "numeric";
  phoneInput.autocomplete = "tel";
  phoneInput.pattern = "(?:[78][0-9]{10}|[0-9]{10})";
  phoneInput.title = "Введите 10 цифр или 11 цифр, начиная с 7 или 8";
  phoneInput.placeholder = "79991234567";
  phoneInput.maxLength = 32;
  phoneInput.addEventListener("input", () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  });
}

if (form && dateInput && timeInput && serviceInput && message && submitButton) {

  // Основная услуга одна, а доп. процедур может быть несколько.
  serviceInput.replaceChildren(
    new Option("Выберите основную услугу", ""),
    new Option("Простой маникюр", "basic"),
    new Option("Маникюр с гель-лаком", "color")
  );
  const extras = [
    { key: "repair", label: "Ремонт ногтей", minutes: 10 },
    { key: "extension", label: "Донаращивание ногтей", minutes: 15 },
    { key: "nails", label: "Наращивание ногтей", minutes: 20 }
  ];
  const counts = { repair: 0, extension: 0, nails: 0 };
  const baseDurations = { basic: 45, color: 75 };
  const selectedAddons = () => Object.fromEntries(
    Object.entries(counts).filter(([, quantity]) => quantity > 0)
  );
  const totalMinutes = () => (baseDurations[serviceInput.value] || 0) +
    extras.reduce((sum, item) => sum + item.minutes * counts[item.key], 0);

  const addonSection = document.createElement("section");
  addonSection.className = "booking-addons";
  addonSection.setAttribute("aria-label", "Дополнительные услуги");
  const addonTitle = document.createElement("h3");
  addonTitle.textContent = "Дополнительные услуги";
  const addonDescription = document.createElement("p");
  addonDescription.textContent = "Можно выбрать несколько дополнительных услуг и указать количество каждой.";
  const addonList = document.createElement("div");
  const addonTotal = document.createElement("p");
  addonTotal.className = "booking-addon-total";
  addonTotal.setAttribute("aria-live", "polite");
  addonSection.append(addonTitle, addonDescription, addonList, addonTotal);
  const serviceWrapper = serviceInput.closest(".form-field");
  if (serviceWrapper && serviceWrapper !== form) serviceWrapper.after(addonSection);
  else serviceInput.after(addonSection);

  // Стили встроены, чтобы не пришлось вставлять JS в style.css.
  if (!document.getElementById("veronika-addon-style")) {
    const style = document.createElement("style");
    style.id = "veronika-addon-style";
    style.textContent = [
      ".booking-addons{width:100%;margin:18px 0 26px;padding:22px;border:1px solid #dcd8d1;border-radius:10px;background:#faf8f5;color:#252322}",
      ".booking-addons h3{margin:0 0 6px;font:600 15px Manrope,sans-serif}",
      ".booking-addons>p{margin:0 0 18px;color:#77726d;font:12px/1.6 Manrope,sans-serif}",
      ".booking-addon-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-top:1px solid #e4dfd8}",
      ".booking-addon-label{font:13px/1.5 Manrope,sans-serif}",
      ".booking-addon-counter{display:flex;align-items:center;gap:10px;flex-shrink:0}",
      ".booking-addon-counter button{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid #dcd8d1;border-radius:7px;background:#f2f0eb;color:#252322;font:20px Manrope,sans-serif;cursor:pointer}",
      ".booking-addon-counter button:disabled{opacity:.35;cursor:not-allowed}",
      ".booking-addon-counter output{min-width:22px;text-align:center;font:500 13px 'DM Mono',monospace}",
      ".booking-addons .booking-addon-total{margin:12px 0 0;padding-top:14px;border-top:1px solid #e4dfd8;color:#77726d;font:12px/1.6 Manrope,sans-serif}",
      "@media(max-width:500px){.booking-addons{padding:16px}.booking-addon-counter{gap:7px}}"
    ].join("\n");
    document.head.append(style);
  }

  const addonControls = {};
  for (const item of extras) {
    const row = document.createElement("div");
    row.className = "booking-addon-row";
    const label = document.createElement("span");
    label.className = "booking-addon-label";
    label.textContent = item.label;
    const controls = document.createElement("div");
    controls.className = "booking-addon-counter";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "Убрать " + item.label);
    const count = document.createElement("output");
    count.textContent = "0";
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Добавить " + item.label);
    controls.append(minus, count, plus);
    row.append(label, controls);
    addonList.append(row);
    addonControls[item.key] = { minus, count, plus };
    minus.addEventListener("click", () => {
      counts[item.key] = Math.max(0, counts[item.key] - 1);
      updateAddons();
    });
    plus.addEventListener("click", () => {
      if (!serviceInput.value || !Number.isSafeInteger(counts[item.key] + 1)) return;
      counts[item.key]++;
      updateAddons();
    });
  }

  function updateAddons(reload = true) {
    const total = totalMinutes();
    for (const item of extras) {
      const control = addonControls[item.key];
      control.count.textContent = String(counts[item.key]);
      control.minus.disabled = counts[item.key] === 0;
      control.plus.disabled = !serviceInput.value;
    }
    addonTotal.textContent = serviceInput.value
      ? "Общее время: " + Math.floor(total / 60) + " ч " +
        String(total % 60).padStart(2, "0") + " мин. " +
        (total > 480
          ? "Выбранные процедуры не помещаются в рабочий день (12:00–20:00)."
          : "Учтено в расписании.")
      : "Сначала выберите основную услугу.";
    if (typeof updateTimeHint === "function") updateTimeHint();
    if (reload && typeof loadAvailableTimes === "function") loadAvailableTimes();
  }


  // Клиент выбирает отдельный канал напоминания. Не подписываем без согласия.
  const reminderSection = document.createElement("section");
  reminderSection.className = "booking-reminder-choice";
  const reminderLabel = document.createElement("label");
  reminderLabel.htmlFor = "reminder-channel";
  reminderLabel.textContent = "Куда отправить напоминание за час до записи?";
  const reminderSelect = document.createElement("select");
  reminderSelect.id = "reminder-channel";
  reminderSelect.name = "reminderChannel";
  const noReminder = new Option("Не нужно напоминание", "none");
  const telegramOption = new Option("Telegram — проверяем подключение", "telegram");
  const smsOption = new Option("Обычное SMS — проверяем подключение", "sms");
  telegramOption.disabled = true;
  smsOption.disabled = true;
  reminderSelect.add(noReminder);
  reminderSelect.add(telegramOption);
  reminderSelect.add(smsOption);
  const reminderHelp = document.createElement("p");
  reminderHelp.className = "booking-reminder-help";
  reminderHelp.textContent = "Доступность Telegram и SMS проверяется. Можно записаться без напоминания.";
  reminderSection.append(reminderLabel, reminderSelect, reminderHelp);
  // Always directly after additional services and before date/time.
  addonSection.after(reminderSection);

  if (!document.getElementById("veronika-reminder-styles")) {
    const style = document.createElement("style");
    style.id = "veronika-reminder-styles";
    style.textContent = [
      "#booking-form .booking-reminder-choice{width:100%;grid-column:1/-1;min-width:0;margin:12px 0 24px}",
      "#booking-form .booking-reminder-choice label{display:block;margin:0 0 10px;font:500 13px Manrope,sans-serif;color:#252322}",
      "#booking-form .booking-reminder-choice select{width:100%;min-width:0;padding:15px;border:1px solid #dcd8d1;border-radius:8px;background:#faf8f5;color:#252322;font:13px Manrope,sans-serif}",
      "#booking-form .booking-reminder-help{margin:8px 0 0;color:#77726d;font:12px/1.55 Manrope,sans-serif}"
    ].join("\n");
    document.head.append(style);
  }

  reminderSelect.addEventListener("change", () => {
    if (reminderSelect.value === "telegram") {
      reminderHelp.textContent = "После записи откройте Telegram по персональной ссылке и запустите бота. Только после этого напоминание будет подключено.";
    } else if (reminderSelect.value === "sms") {
      reminderHelp.textContent = "Обычное SMS придёт на номер, указанный выше, при работающем SMS-шлюзе.";
    } else {
      reminderHelp.textContent = "Напоминания отправляться не будут.";
    }
  });

  fetch(API_BASE + "/api/reminder-options", { cache: "no-store" })
    .then(async response => {
      if (!response.ok) throw new Error("reminder-options unavailable");
      const data = await response.json();
      telegramOption.disabled = !data.telegram;
      smsOption.disabled = !data.sms;
      telegramOption.textContent = data.telegram
        ? "Telegram (бесплатно)" : "Telegram (пока не подключён)";
      smsOption.textContent = data.sms
        ? "Обычное SMS" : "Обычное SMS (пока не подключено)";
      reminderHelp.textContent = data.sms
        ? "Выберите удобный способ. Для Telegram после записи нужно запустить бота."
        : "SMS-шлюз пока не подключён. Можно выбрать Telegram, если бот настроен, или записаться без напоминания.";
    })
    .catch(() => {
      reminderHelp.textContent = "Проверить способы напоминания пока не получилось. Можно записаться без напоминания.";
    });

  const today = dateInMoscow();
  const maxDay = new Date(today + "T12:00:00Z");
  maxDay.setUTCDate(maxDay.getUTCDate() + 90);

  // Нативный календарь, но открывается по нажатию на всю область поля.
  dateInput.type = "date";
  dateInput.min = today;
  dateInput.max = maxDay.toISOString().slice(0, 10);
  dateInput.required = true;
  dateInput.setAttribute("aria-label", "Дата записи");
  const calendarShell = document.createElement("div");
  calendarShell.className = "booking-calendar-shell";
  dateInput.before(calendarShell);
  calendarShell.append(dateInput);

  // Не рисуем вторую иконку: Safari уже показывает встроенную.
  // Дополнительная иконка раньше сдвигала календарь внутрь поля.
  dateInput.addEventListener("click", () => {
    if (typeof dateInput.showPicker === "function") {
      try { dateInput.showPicker(); } catch (_error) { dateInput.focus(); }
    }
  });

  // Простое текстовое поле: можно набрать 12:30, а можно выбрать кнопкой.
  timeInput.type = "text";
  timeInput.required = true;
  timeInput.placeholder = "Выберите время или введите 12:30";
  timeInput.inputMode = "numeric";
  timeInput.maxLength = 5;
  timeInput.pattern = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
  timeInput.title = "Введите время в формате ЧЧ:ММ, например 12:30";
  timeInput.autocomplete = "off";

  // Выбор свободного времени непосредственно в поле, с поддержкой ручного ввода.
  const timeContainer = timeInput.parentElement;
  timeContainer.classList.add("booking-time-field");
  const timeDropdown = document.createElement("div");
  timeDropdown.className = "booking-time-dropdown";
  timeDropdown.id = "booking-time-dropdown";
  timeDropdown.setAttribute("role", "listbox");
  timeDropdown.setAttribute("aria-label", "Свободные варианты времени");
  timeDropdown.hidden = true;
  timeInput.after(timeDropdown);
  timeInput.setAttribute("aria-controls", "booking-time-dropdown");
  timeInput.setAttribute("aria-expanded", "false");
  let availableTimes = [];
  function hideTimeDropdown() {
    timeDropdown.hidden = true;
    timeInput.setAttribute("aria-expanded", "false");
  }
  function setSelectedTime(time) {
    timeInput.value = time;
    clearTimeout(checkTimer);
    ++validationVersion;
    highlightTime();
    hideTimeDropdown();
    setMessage("Выбрано свободное время: " + time + ".");
  }
  function renderTimeDropdown(showAll = false) {
    timeDropdown.replaceChildren();
    const prefix = showAll ? "" : timeInput.value.trim();
    const filtered = availableTimes
      .filter(time => !prefix || time.startsWith(prefix));
    if (!filtered.length) {
      hideTimeDropdown();
      return;
    }
    for (const time of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "booking-time-dropdown-option";
      button.setAttribute("role", "option");
      button.textContent = time;
      button.addEventListener("click", () => setSelectedTime(time));
      timeDropdown.append(button);
    }
    timeDropdown.hidden = false;
    timeInput.setAttribute("aria-expanded", "true");
  }
  timeInput.addEventListener("focus", () => renderTimeDropdown(true));
  timeInput.addEventListener("click", () => renderTimeDropdown(true));
  timeInput.addEventListener("keydown", event => {
    if (event.key === "Escape") hideTimeDropdown();
  });
  document.addEventListener("pointerdown", event => {
    if (!timeContainer.contains(event.target)) hideTimeDropdown();
  });

  if (!document.getElementById("veronika-picker-fixes")) {
    const pickerStyle = document.createElement("style");
    pickerStyle.id = "veronika-picker-fixes";
    pickerStyle.textContent = [
      "#booking-form .booking-calendar-shell{position:relative;width:100%;min-width:0}",
      "#booking-form .booking-calendar-shell input[type=date]{display:block;width:100%;min-width:0;height:56px;box-sizing:border-box;padding:0 15px;cursor:pointer;appearance:auto}",
      "#booking-form .booking-calendar-shell input[type=date]::-webkit-calendar-picker-indicator{position:static;display:block;opacity:1;margin:0;cursor:pointer}",
      "#booking-form .booking-calendar-button{display:none!important}",
      "#booking-form .booking-time-field{position:relative;min-width:0;overflow:visible}",
      "#booking-form .booking-time-dropdown[hidden]{display:none!important}",
      "#booking-form .booking-time-dropdown{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:30;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;max-height:218px;overflow:auto;padding:12px;border:1px solid #dcd8d1;border-radius:9px;background:#faf8f5;box-shadow:0 15px 35px rgba(37,35,34,.16)}",
      "#booking-form .booking-time-dropdown-option{min-width:0;padding:10px 5px;border:1px solid #e1dbd5;border-radius:6px;background:#fff;color:#252322;font:500 12px Manrope,sans-serif;cursor:pointer}",
      "#booking-form .booking-time-dropdown-option:hover{border-color:#a67c78;background:#f1e9e4}",
      "#booking-form .booking-time-suggestions{display:block;width:100%;grid-column:1/-1;margin:16px 0 24px}",
      "#booking-form .booking-time-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
      "@media(max-width:600px){#booking-form .booking-time-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}"
    ].join("\n");
    document.head.append(pickerStyle);
  }

  // Если в index.html уже есть контейнер, используем его.
  const suggestions = document.getElementById("booking-time-suggestions") ||
    document.createElement("div");
  suggestions.classList.add("booking-time-suggestions");
  suggestions.setAttribute("aria-label", "Доступное время записи");
  suggestions.replaceChildren();
  const timeHelp = document.createElement("div");
  timeHelp.className = "booking-time-caption";
  timeHelp.textContent = "СВОБОДНОЕ ВРЕМЯ · ИЛИ ВВЕДИТЕ СВОЁ";
  function updateTimeHint() {
    timeHelp.textContent = "СВОБОДНОЕ ВРЕМЯ · ШАГ 30 МИН · ИЛИ ВВЕДИТЕ СВОЁ";
  }
  const slotGrid = document.createElement("div");
  slotGrid.className = "booking-time-grid";
  suggestions.append(timeHelp, slotGrid);
  if (!suggestions.isConnected) {
    (timeInput.closest(".form-field") || timeInput.parentElement).after(suggestions);
  }

  let slotVersion = 0;
  let validationVersion = 0;
  let checkTimer;

  function setMessage(text, error = false) {
    message.textContent = text;
    message.style.color = error ? "#b44d42" : "";
  }
  function setEmpty(text) {
    slotGrid.replaceChildren();
    const placeholder = document.createElement("p");
    placeholder.className = "booking-time-empty";
    placeholder.textContent = text;
    slotGrid.append(placeholder);
  }
  function highlightTime() {
    slotGrid.querySelectorAll("button[data-time]").forEach(button => {
      const chosen = button.dataset.time === timeInput.value;
      button.classList.toggle("is-selected", chosen);
      button.setAttribute("aria-pressed", String(chosen));
    });
  }

  async function loadAvailableTimes() {
    const version = ++slotVersion;
    clearTimeout(checkTimer);
    ++validationVersion;
    slotGrid.replaceChildren();
    timeInput.value = "";
    availableTimes = [];
    hideTimeDropdown();
    if (!dateInput.value || !serviceInput.value) {
      setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
      return;
    }
    const day = new Date(dateInput.value + "T12:00:00Z").getUTCDay();
    if (day === 0 || day === 6) {
      setEmpty("Выбрана суббота или воскресенье. Мастер принимает по будням.");
      setMessage("Выберите рабочую дату с понедельника по пятницу.", true);
      return;
    }
    setEmpty("Загружаем свободные часы...");
    try {
      const query = new URLSearchParams({
        date: dateInput.value,
        service: serviceInput.value,
        addons: JSON.stringify(selectedAddons())
      });
      const response = await fetch(API_BASE + "/api/slots?" + query, {
        cache: "no-store"
      });
      const data = await response.json();
      if (version !== slotVersion) return;
      if (!response.ok) throw new Error(data.error || "Не удалось загрузить часы");
      const times = Array.isArray(data.times) ? data.times : [];
      availableTimes = times;
      slotGrid.replaceChildren();
      if (!times.length) {
        setEmpty("На этот день свободного времени нет. Выберите другую дату.");
        setMessage("Свободных записей на эту дату нет.", true);
        return;
      }
      for (const time of times) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "booking-time-option";
        button.textContent = time;
        button.dataset.time = time;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          setSelectedTime(time);
        });
        slotGrid.append(button);
      }
      setMessage("Выберите свободное время ниже или введите своё.");
    } catch (error) {
      if (version !== slotVersion) return;
      setEmpty("Не удалось загрузить доступное время.");
      setMessage(error.message, true);
    }
  }

  async function checkManualTime() {
    const version = ++validationVersion;
    const time = timeInput.value;
    if (!dateInput.value || !serviceInput.value ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    try {
      const params = new URLSearchParams({
        date: dateInput.value, service: serviceInput.value, time,
        addons: JSON.stringify(selectedAddons())
      });
      const response = await fetch(API_BASE + "/api/availability?" + params, {
        cache: "no-store"
      });
      const data = await response.json();
      if (version !== validationVersion) return;
      setMessage(data.message || data.error || "Не удалось проверить время",
        !response.ok || !data.available);
    } catch (error) {
      if (version !== validationVersion) return;
      setMessage("Не удалось проверить время: " + error.message, true);
    }
  }

  dateInput.addEventListener("change", loadAvailableTimes);
  serviceInput.addEventListener("change", () => updateAddons());
  timeInput.addEventListener("input", () => {
    // Автоматическая маска: 123 -> 12:3, 1230 -> 12:30.
    const digits = timeInput.value.replace(/\D/g, "").slice(0, 4);
    timeInput.value = digits.length > 2
      ? digits.slice(0, 2) + ":" + digits.slice(2)
      : digits;
    highlightTime();
    renderTimeDropdown(false);
    clearTimeout(checkTimer);
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(timeInput.value)) {
      checkTimer = setTimeout(checkManualTime, 350);
    }
  });
  timeInput.addEventListener("change", checkManualTime);

  updateAddons(false);
  setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
  if (dateInput.value && serviceInput.value) loadAvailableTimes();

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submitButton.disabled = true;
    document.getElementById("veronika-telegram-optin")?.remove();
    setMessage("Проверяем время и создаём запись...");
    const chosenDate = dateInput.value;
    const chosenTime = timeInput.value;

    try {
      const response = await fetch(API_BASE + "/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("name").value.trim(),
          phone: phoneInput.value,
          service: serviceInput.value,
          addons: selectedAddons(),
          reminderChannel: reminderSelect.value,
          date: chosenDate,
          time: chosenTime
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось создать запись");
      form.reset();
      for (const key of Object.keys(counts)) counts[key] = 0;
      updateAddons(false);
      ++slotVersion;
      ++validationVersion;
      setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
      setMessage("Вы успешно записаны на " + chosenDate + " в " + chosenTime + (data.reminderChannel === "sms" ? ". Напоминание придёт по SMS за час." : "."));
      reminderSelect.dispatchEvent(new Event("change"));
      if (typeof data.telegramLink === "string" &&
          /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]{20,64}$/.test(data.telegramLink)) {
        const reminderLink = document.createElement("a");
        reminderLink.id = "veronika-telegram-optin";
        reminderLink.href = data.telegramLink;
        reminderLink.target = "_blank";
        reminderLink.rel = "noopener noreferrer";
        reminderLink.textContent = "Подключить бесплатное напоминание за час в Telegram ↗";
        reminderLink.style.cssText = "display:block;margin:14px 0;padding:14px;border:1px solid #dcd8d1;border-radius:8px;color:#252322;background:#faf8f5;font-size:13px;text-decoration:none";
        message.after(reminderLink);
      }
    } catch (error) {
      setMessage(error.message, true);
      if (/занят|перерыв|время закрыто/i.test(error.message)) {
        await loadAvailableTimes();
      }
    } finally {
      submitButton.disabled = false;
    }
  });
}


/* VERONIKA — PRIVACY: compatible with the earlier consent dialog. */
document.addEventListener("DOMContentLoaded", () => {
  const dialog = document.getElementById("privacy-dialog");
  const checkbox = document.getElementById("privacy-consent");
  const bookingForm = document.getElementById("booking-form");
  if (!dialog || !checkbox || !bookingForm) return;

  function showPrivacy() {
    if (!dialog.open) dialog.showModal();
  }
  function hidePrivacy() {
    if (dialog.open) dialog.close();
  }

  document.querySelectorAll("[data-open-privacy]").forEach(button => {
    button.addEventListener("click", showPrivacy);
  });
  document.getElementById("privacy-close")?.addEventListener("click", hidePrivacy);
  document.getElementById("privacy-decline")?.addEventListener("click", hidePrivacy);
  document.getElementById("privacy-accept")?.addEventListener("click", () => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    hidePrivacy();
  });

  bookingForm.addEventListener("click", event => {
    const submit = event.target.closest('button[type="submit"], input[type="submit"]');
    if (submit && !checkbox.checked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showPrivacy();
    }
  }, true);

  bookingForm.addEventListener("submit", event => {
    if (!checkbox.checked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showPrivacy();
    }
  }, true);
});
