// После деплоя замените адрес на HTTPS-адрес проекта API в ONREZA.
const API_BASE = "https://veronika-api-lashkovmaximik-g7tm.onreza.app";

const form = document.getElementById("booking-form");
const dateInput = document.getElementById("date");
const timeSelect = document.getElementById("time");
const message = document.getElementById("message");
const button = form?.querySelector('[type="submit"]');

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

function setOptions(label, slots = []) {
  timeSelect.replaceChildren(new Option(label, ""));
  for (const slot of slots) timeSelect.add(new Option(slot, slot));
}

if (form && dateInput && timeSelect && button && message) {
  dateInput.min = dateInMoscow();
  const maxDate = new Date(`${dateInMoscow()}T12:00:00Z`);
  maxDate.setUTCDate(maxDate.getUTCDate() + 90);
  dateInput.max = maxDate.toISOString().slice(0, 10);

  button.disabled = false;
  setOptions("Выберите дату");

  async function loadTimes() {
    setOptions("Загрузка...");
    if (!dateInput.value) return setOptions("Выберите дату");

    try {
      const response = await fetch(
        `${API_BASE}/api/slots?date=${encodeURIComponent(dateInput.value)}`,
        { cache: "no-store" }
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Не удалось загрузить время");
      setOptions(data.times.length ? "Выберите время" : "Свободного времени нет", data.times);
      message.textContent = "";
    } catch (error) {
      setOptions("Не удалось загрузить время");
      message.textContent = error.message;
    }
  }

  dateInput.addEventListener("change", loadTimes);

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    button.disabled = true;
    message.textContent = "Сохраняем запись...";
    const selected = { date: dateInput.value, time: timeSelect.value };

    try {
      const response = await fetch(`${API_BASE}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("name").value.trim(),
          phone: document.getElementById("phone").value.trim(),
          service: document.getElementById("service").value,
          ...selected
        })
      });

      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Не удалось создать запись");

      form.reset();
      await loadTimes();
      message.textContent = `Тестовая запись создана: ${selected.date}, ${selected.time}.`;
    } catch (error) {
      message.textContent = error.message;
      await loadTimes();
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
