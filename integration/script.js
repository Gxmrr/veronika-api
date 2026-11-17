// VERONIKA: the server supplies available 15-minute booking slots.
const API_BASE = "https://veronika-api-lashkovmaximik-g7tm.onreza.app";
const form = document.getElementById("booking-form");
const dateInput = document.getElementById("date");
const serviceInput = document.getElementById("service");
const phoneInput = document.getElementById("phone");
const message = document.getElementById("message");
const submitButton = form?.querySelector('[type="submit"]');

// Replace the previous manual time input with a list of available slots.
const previousTime = document.getElementById("time");
let timeInput = previousTime;
if (previousTime && previousTime.tagName !== "SELECT") {
  const select = document.createElement("select");
  select.id = previousTime.id;
  select.name = previousTime.name || "time";
  select.className = previousTime.className;
  select.required = true;
  select.setAttribute("aria-label", "Доступное время");
  previousTime.replaceWith(select);
  timeInput = select;
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
  phoneInput.setAttribute("inputmode", "numeric");
  phoneInput.setAttribute("autocomplete", "tel");
  phoneInput.setAttribute("pattern", "(?:[78][0-9]{10}|[0-9]{10})");
  phoneInput.setAttribute("title", "Введите 10 цифр или 11 цифр, начиная с 7 или 8");
  phoneInput.setAttribute("placeholder", "79991234567");
  phoneInput.maxLength = 11;
  phoneInput.addEventListener("input", () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  });
}

if (form && dateInput && serviceInput && timeInput && message && submitButton) {
  dateInput.min = dateInMoscow();
  const maxDay = new Date(dateInMoscow() + "T12:00:00Z");
  maxDay.setUTCDate(maxDay.getUTCDate() + 90);
  dateInput.max = maxDay.toISOString().slice(0, 10);
  let requestVersion = 0;

  const showMessage = (text, error = false) => {
    message.textContent = text;
    message.style.color = error ? "#b44d42" : "";
  };

  function emptyTimes(prompt = "Сначала выберите услугу и дату") {
    timeInput.replaceChildren(new Option(prompt, "", true, true));
    timeInput.disabled = true;
  }

  async function loadFreeTimes() {
    const version = ++requestVersion;
    const previous = timeInput.value;
    emptyTimes("Загружаем свободные часы...");
    if (!dateInput.value || !serviceInput.value) {
      emptyTimes();
      showMessage("Выберите услугу и дату — появятся доступные часы.");
      return;
    }
    try {
      const params = new URLSearchParams({
        date: dateInput.value,
        service: serviceInput.value
      });
      const response = await fetch(API_BASE + "/api/slots?" + params, {
        cache: "no-store"
      });
      const result = await response.json();
      if (version !== requestVersion) return;
      if (!response.ok) {
        throw new Error(result.error || "Не удалось загрузить свободное время");
      }
      const times = Array.isArray(result.times) ? result.times : [];
      emptyTimes(times.length ? "Выберите свободное время" : "Свободного времени нет");
      for (const time of times) {
        timeInput.add(new Option(time, time));
      }
      timeInput.disabled = times.length === 0;
      if (times.includes(previous)) timeInput.value = previous;
      showMessage(times.length
        ? "Свободных вариантов: " + times.length + ". Выберите удобное время."
        : "На эту дату нет доступного времени. Попробуйте другой день.",
        times.length === 0);
    } catch (error) {
      if (version !== requestVersion) return;
      emptyTimes("Ошибка загрузки времени");
      showMessage("Не удалось получить время: " + error.message, true);
    }
  }

  dateInput.addEventListener("change", loadFreeTimes);
  serviceInput.addEventListener("change", loadFreeTimes);
  timeInput.addEventListener("change", () => {
    if (timeInput.value) showMessage("Выбрано время: " + timeInput.value);
  });

  emptyTimes();
  if (dateInput.value && serviceInput.value) loadFreeTimes();

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (!timeInput.value) {
      showMessage("Пожалуйста, выберите свободное время.", true);
      return;
    }
    submitButton.disabled = true;
    showMessage("Сохраняем запись...");
    const selected = { date: dateInput.value, time: timeInput.value };
    try {
      const response = await fetch(API_BASE + "/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("name").value.trim(),
          phone: phoneInput.value,
          service: serviceInput.value,
          date: selected.date,
          time: selected.time
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Не удалось создать запись");
      form.reset();
      requestVersion++;
      emptyTimes();
      showMessage("Запись создана на " + selected.date + " в " + selected.time + ".");
    } catch (error) {
      showMessage(error.message, true);
      // Another customer may have booked the same slot.
      if (error.message.includes("занят") || error.message.includes("перерыва")) {
        await loadFreeTimes();
      }
    } finally {
      submitButton.disabled = false;
    }
  });
}
