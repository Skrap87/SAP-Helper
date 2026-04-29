"use strict";

document.getElementById("refreshHistory").addEventListener("click", loadHistory);
document.getElementById("runProbe").addEventListener("click", runProbe);
document.addEventListener("DOMContentLoaded", async () => {
  await renderStatus();
  await loadHistory();
});

async function renderStatus() {
  const status = document.getElementById("status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  status.textContent = tab ? `Активная вкладка: ${tab.url || "-"}` : "Активная вкладка не найдена";
}

async function runProbe() {
  const status = document.getElementById("status");
  status.textContent = "Выполняю executeScript probe...";
  const response = await chrome.runtime.sendMessage({ type: "HU_DIAG_RUN_EXECUTESCRIPT" });
  status.textContent = response?.ok
    ? `Probe: ${response.result?.success ? "успех" : "не найдено"}, HU=${response.result?.hu || "-"}`
    : "Probe завершился с ошибкой";
  await loadHistory();
}

async function loadHistory() {
  const out = document.getElementById("history");
  const response = await chrome.runtime.sendMessage({ type: "HU_DIAG_GET_HISTORY" });
  if (!response?.ok) {
    out.textContent = "Ошибка чтения истории";
    return;
  }

  const history = Array.isArray(response.history) ? response.history.slice(0, 30) : [];
  out.textContent = history.length ? JSON.stringify(history, null, 2) : "История пуста. Открой SAP страницу и дождись toast/логов.";
}
