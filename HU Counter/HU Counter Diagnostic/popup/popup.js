"use strict";

document.getElementById("refreshHistory").addEventListener("click", loadHistory);
document.addEventListener("DOMContentLoaded", loadHistory);

async function loadHistory() {
  const out = document.getElementById("history");
  const response = await chrome.runtime.sendMessage({ type: "HU_DIAG_GET_HISTORY" });
  if (!response?.ok) {
    out.textContent = "Ошибка чтения истории";
    return;
  }

  const history = Array.isArray(response.history) ? response.history.slice(0, 25) : [];
  out.textContent = JSON.stringify(history, null, 2);
}
