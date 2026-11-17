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

  const calendarButton = document.createElement("button");
  calendarButton.type = "button";
  calendarButton.className = "booking-calendar-button";
  calendarButton.setAttribute("aria-label", "Открыть календарь");
  calendarButton.textContent = "▦";
  calendarShell.append(calendarButton);
  function openCalendar() {
    if (typeof dateInput.showPicker === "function") {
      try { dateInput.showPicker(); return; } catch (_error) {}
    }
    dateInput.focus();
  }
  calendarButton.addEventListener("click", openCalendar);
  dateInput.addEventListener("click", openCalendar);

  // Простое текстовое поле: можно набрать 12:30, а можно выбрать кнопкой.
  timeInput.type = "text";
  timeInput.required = true;
  timeInput.placeholder = "Например, 12:30";
  timeInput.inputMode = "numeric";
  timeInput.maxLength = 5;
  timeInput.pattern = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
  timeInput.title = "Введите время в формате ЧЧ:ММ, например 12:30";
  timeInput.autocomplete = "off";

  // Если в index.html уже есть контейнер, используем его.
  const suggestions = document.getElementById("booking-time-suggestions") ||
    document.createElement("div");
  suggestions.classList.add("booking-time-suggestions");
  suggestions.setAttribute("aria-label", "Доступное время записи");
  suggestions.replaceChildren();
  const timeHelp = document.createElement("div");
  timeHelp.className = "booking-time-caption";
  timeHelp.textContent = "СВОБОДНОЕ ВРЕМЯ · ИЛИ ВВЕДИТЕ СВОЁ";
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
    if (!dateInput.value || !serviceInput.value) {
      setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
      return;
    }
    setEmpty("Загружаем свободные часы...");
    try {
      const query = new URLSearchParams({
        date: dateInput.value,
        service: serviceInput.value
      });
      const response = await fetch(API_BASE + "/api/slots?" + query, {
        cache: "no-store"
      });
      const data = await response.json();
      if (version !== slotVersion) return;
      if (!response.ok) throw new Error(data.error || "Не удалось загрузить часы");
      const times = Array.isArray(data.times) ? data.times : [];
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
          timeInput.value = time;
          highlightTime();
          setMessage("Выбрано время: " + time + ".");
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
        date: dateInput.value, service: serviceInput.value, time
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
  serviceInput.addEventListener("change", loadAvailableTimes);
  timeInput.addEventListener("input", () => {
    // 1230 превращается в 12:30, а 12:30 остаётся 12:30.
    let value = timeInput.value.replace(/[^\d:]/g, "");
    if (/^\d{4}$/.test(value)) value = value.slice(0, 2) + ":" + value.slice(2);
    timeInput.value = value.slice(0, 5);
    highlightTime();
    clearTimeout(checkTimer);
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(timeInput.value)) {
      checkTimer = setTimeout(checkManualTime, 350);
    }
  });
  timeInput.addEventListener("change", checkManualTime);

  setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
  if (dateInput.value && serviceInput.value) loadAvailableTimes();

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submitButton.disabled = true;
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
          date: chosenDate,
          time: chosenTime
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось создать запись");
      form.reset();
      ++slotVersion;
      ++validationVersion;
      setEmpty("Выберите дату и услугу, чтобы увидеть свободное время.");
      setMessage("Вы успешно записаны на " + chosenDate + " в " + chosenTime + ".");
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
