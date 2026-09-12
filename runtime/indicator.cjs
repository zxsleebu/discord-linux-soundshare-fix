// SPDX-License-Identifier: MIT
"use strict";

// Exact accessible names: fail closed instead of decorating unrelated buttons.
const LABELS = new Set([
  "Stop Streaming", "Share Your Screen", "Share Screen", "Start Streaming",
  "Остановить трансляцию", "Демонстрация экрана", "Продемонстрировать экран",
]);
const COLORS = { active: "#43d9a3", waiting: "#f0c35a", error: "#f57983", unknown: "#a6adba" };

function describeStatus(status) {
  const states = {
    1: ["active", "Hook active · patch verified"],
    0: ["waiting", "Waiting for voice module"],
    2: ["error", "Hook installation failed"],
    3: ["error", "Fix disabled"],
    4: ["error", "Hook missing or modified"],
    "-1": ["error", "Fix not loaded · restart from the Discord icon"],
    "-2": ["unknown", "Older fix loaded · restart to enable status"],
  };
  const [kind, message] = states[status?.state] ?? ["unknown", "Status unavailable"];
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "?";
  return {
    kind, color: COLORS[kind],
    text: `Soundshare Fix\n${message}` + (status?.state === 1
      ? `\nSignals: ${count(status.hits)} · blocked restarts: ${count(status.blocked)}` : ""),
  };
}

function isShareButton(button) {
  return LABELS.has(button.getAttribute("aria-label") ?? "");
}

function mountIndicator({ document, window, readStatus }) {
  const records = new Map();
  let sequence = 0;
  let stopped = false;
  function remove(button, record) {
    record.dot.remove();
    record.tooltip.remove();
    for (const [event, handler] of record.listeners) button.removeEventListener(event, handler);
    const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== record.tooltip.id);
    if (ids.length) button.setAttribute("aria-describedby", ids.join(" "));
    else button.removeAttribute("aria-describedby");
    records.delete(button);
  }
  function position(button, record) {
    const rect = button.getBoundingClientRect();
    const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
      topElement && button.contains(topElement);
    record.dot.style.display = visible ? "block" : "none";
    record.dot.style.left = `${rect.right - 10}px`;
    record.dot.style.top = `${rect.top + 3}px`;
    record.tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`;
    const height = record.tooltip.getBoundingClientRect().height || 80;
    record.tooltip.style.top = `${Math.max(8, rect.bottom + 8 + height <= window.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
    if (!visible) record.tooltip.style.visibility = "hidden";
  }
  function create(button) {
    const dot = document.createElement("span");
    dot.dataset.soundshareFix = "indicator";
    dot.setAttribute("aria-hidden", "true");
    // A separate overlay leaves React's tree, layout and click handling untouched.
    dot.style.cssText = "position:fixed;width:7px;height:7px;box-sizing:content-box;border:2px solid #20242b;border-radius:50%;pointer-events:none;z-index:1000;";
    const tooltip = document.createElement("div");
    tooltip.id = `soundshare-fix-status-${++sequence}`;
    tooltip.setAttribute("role", "tooltip");
    tooltip.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;z-index:1001;max-width:304px;padding:9px 12px;border:1px solid #ffffff18;border-radius:9px;background:#17191f;color:#eceef2;box-shadow:0 5px 18px #0005;font:12px/1.6 var(--font-primary,system-ui);white-space:pre-line;";
    document.body.append(dot, tooltip);
    const oldDescription = button.getAttribute("aria-describedby");
    button.setAttribute("aria-describedby", [oldDescription, tooltip.id].filter(Boolean).join(" "));
    const show = () => { position(button, record); tooltip.style.visibility = "visible"; };
    const hide = () => { tooltip.style.visibility = "hidden"; };
    const move = (event) => {
      const rect = dot.getBoundingClientRect();
      if (event.clientX >= rect.left - 3 && event.clientX <= rect.right + 3 &&
          event.clientY >= rect.top - 3 && event.clientY <= rect.bottom + 3) show();
      else hide();
    };
    const listeners = [["pointermove", move], ["pointerleave", hide], ["focus", show], ["blur", hide],
      ["keydown", (event) => { if (event.key === "Escape") hide(); }]];
    const record = { dot, tooltip, listeners };
    for (const [event, handler] of listeners) button.addEventListener(event, handler);
    records.set(button, record);
    return record;
  }
  function update() {
    if (stopped || !document.body) return;
    let status;
    try { status = readStatus(); } catch { status = null; }
    const view = describeStatus(status);
    const buttons = new Set([...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')].filter(isShareButton));
    for (const [button, record] of records) if (!buttons.has(button)) remove(button, record);
    for (const button of buttons) {
      const record = records.get(button) ?? create(button);
      record.dot.style.backgroundColor = view.color;
      record.dot.dataset.state = view.kind;
      if (record.tooltip.textContent !== view.text) record.tooltip.textContent = view.text;
      position(button, record);
    }
  }
  // UI failures never stop audio or leave a stale green badge behind.
  function refresh() {
    try { update(); } catch { stop(); }
  }
  const timer = window.setInterval(refresh, 1000);
  const reposition = () => { for (const [button, record] of records) position(button, record); };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("pagehide", stop, { once: true });
  function stop() {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("pagehide", stop);
    for (const [button, record] of records) remove(button, record);
  }
  refresh();
  return { stop, refresh };
}

module.exports = { describeStatus, isShareButton, mountIndicator };

if (typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.__soundshareFixIndicator) {
  // No contextBridge, remote-debugging port, filesystem API or IPC is exposed to the page.
  let readStatus = () => null;
  try { readStatus = require("./discord_soundshare_fix_status.node").readStatus; }
  catch (error) { console.warn("[discord-soundshare-fix] status bridge unavailable", error.message); }
  globalThis.__soundshareFixIndicator = mountIndicator({ document, window, readStatus });
}
