// Форма VERONIKA: пользователь вводит любое время с точностью до минуты.
// Сервер проверяет рабочие часы, длительность услуги и перерыв.
const API_BASE = "https://veronika-api-lashkovmaximik-g7tm.onreza.app";
const form = document.getElementById("booking-form");
const dateInput = document.getElementById("date");
const serviceInput = document.getElementById("service");
const message = document.getElementById("message");
const submitButton = form?.querySelector('[type="submit"]');

function dateInMoscow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Если в HTML осталось <select id="time">, автоматически меняем его
// на стандартное поле времени. Стили по id="time" при этом сохраняются.
const previousTime = document.getElementById("time");
let timeInput = previousTime;
if (previousTime && previousTime.tagName === "SELECT") {
  timeInput = document.createElement("input");
  timeInput.id = "time";
  timeInput.name = previousTime.name || "time";
  timeInput.type = "time";
  timeInput.required = true;
  timeInput.className = previousTime.className;
  timeInput.setAttribute("aria-label", "Время записи");
  previousTime.replaceWith(timeInput);
}

if (form && dateInput && serviceInput && timeInput && message && submitButton) {
  // Услуги и длительность в минутах — должны совпадать с сервером.
  const durations = {
    basic: 60,
    color: 150,
    repair: 60,
    extension: 90,
    nails: 60,
    "Простой маникюр": 60,
    "Маникюр в один тон": 150,
    "Ремонт ногтя": 60,
    "Донаращивание": 90,
    "Донаращивание ногтя": 90,
    "Наращивание": 60,
    "Наращивание ногтя": 60
  };

  const getDuration = () => durations[serviceInput.value] || 150;
  const toClock = minutes => 
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  dateInput.min = dateInMoscow();
  const lastDay = new Date(`${dateInMoscow()}T12:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() + 90);
  dateInput.max = lastDay.toISOString().slice(0, 10);

  timeInput.type = "time";
  timeInput.step = "60"; // 60 секунд = любая минута
  timeInput.required = true;
  timeInput.min = "12:00";
  submitButton.disabled = false;

  function updateTimeLimit() {
    timeInput.max = toClock(20 * 60 - getDuration());
    if (timeInput.value && !timeInput.checkValidity()) {
      timeInput.value = "";
    }
  }
  updateTimeLimit();

  let validationRequest = 0;
  async function checkAvailability() {
    const version = ++validationRequest;
    if (!dateInput.value || !serviceInput.value || !timeInput.value) {
      message.textContent = "Выберите услугу, дату и удобное время.";
      return;
    }
    if (!timeInput.checkValidity()) {
      message.textContent = "Время должно помещаться в график с 12:00 до 20:00.";
      return;
    }

    message.textContent = "Проверяем свободное время...";
    try {
      const params = new URLSearchParams({
        date: dateInput.value,
        service: serviceInput.value,
        time: timeInput.value
      });
      const res = await fetch(`${API_BASE}/api/availability?${params}`, {
        cache: "no-store"
      });
      const data = await res.json();
      if (version !== validationRequest) return;
      if (!res.ok) throw new Error(data.error || "Ошибка проверки");
      message.textContent = data.message;
      message.style.color = data.available ? "" : "#b44d42";
    } catch (error) {
      if (version !== validationRequest) return;
      message.textContent = "Не удалось проверить время: " + error.message;
    }
  }

  serviceInput.addEventListener("change", () => {
    updateTimeLimit();
    checkAvailability();
  });
  dateInput.addEventListener("change", checkAvailability);
  timeInput.addEventListener("change", checkAvailability);

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    message.textContent = "Сохраняем запись...";
    const selected = { date: dateInput.value, time: timeInput.value };

    try {
      const response = await fetch(`${API_BASE}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("name").value.trim(),
          phone: document.getElementById("phone").value.trim(),
          service: serviceInput.value,
          ...selected
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Запись не создана");

      form.reset();
      validationRequest++;
      updateTimeLimit();
      message.style.color = "";
      message.textContent = `Тестовая запись создана: ${selected.date}, ${selected.time}.`;
    } catch (error) {
      message.style.color = "#b44d42";
      message.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}
