/**
 * ROOT status mailer. Install as a private Google Apps Script owned by the
 * recipient. Set ROOT_ADMIN_TOKEN in Script Properties, then run install().
 * No credential is stored in this source file or included in emails.
 */
const ROOT_STATUS_URL =
  "https://agent.christian-schoenherr73.workers.dev/admin/autonomy";
const ROOT_WORKER_URL = "https://agent.christian-schoenherr73.workers.dev/";
const ROOT_RECIPIENT = "christian.schoenherr73@gmail.com";

function install() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty("ROOT_ADMIN_TOKEN")) {
    throw new Error("Set ROOT_ADMIN_TOKEN in Script Properties first.");
  }
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === "checkRootStatus")
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("checkRootStatus").timeBased().everyMinutes(15).create();
  checkRootStatus();
}

function checkRootStatus() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    checkRootStatusLocked();
  } finally {
    lock.releaseLock();
  }
}

function checkRootStatusLocked() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty("ROOT_ADMIN_TOKEN");
  if (!token) throw new Error("ROOT_ADMIN_TOKEN is missing.");

  let response;
  try {
    response = UrlFetchApp.fetch(ROOT_STATUS_URL, {
      method: "get",
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
  } catch (_) {
    recordStatusFailure(properties, "Network error");
    return;
  }
  if (response.getResponseCode() !== 200) {
    recordStatusFailure(properties, `HTTP ${response.getResponseCode()}`);
    return;
  }

  let status;
  try {
    status = JSON.parse(response.getContentText());
  } catch (_) {
    recordStatusFailure(properties, "Invalid status response");
    return;
  }
  const failures = Number(properties.getProperty("fetchFailures") || 0);
  properties.setProperty("fetchFailures", "0");
  if (failures >= 3 && properties.getProperty("outageNotified")) {
    MailApp.sendEmail(
      ROOT_RECIPIENT,
      "[ROOT] Statuszugriff wiederhergestellt",
      `Der ROOT-Status ist wieder erreichbar.\n\n${ROOT_WORKER_URL}`
    );
    properties.deleteProperty("outageNotified");
    return;
  }

  const mission = status.lastMission || null;
  const fingerprint = mission
    ? Utilities.base64EncodeWebSafe(
        Utilities.computeDigest(
          Utilities.DigestAlgorithm.SHA_256,
          JSON.stringify([
            mission.status,
            mission.summary,
            mission.evidenceCount,
            (status.musicDrafts || []).map((draft) => draft.id),
            mission.modelCalls,
            mission.toolCalls
          ])
        )
      ).slice(0, 24)
    : "none";
  if (!properties.getProperty("initialSent")) {
    MailApp.sendEmail(
      ROOT_RECIPIENT,
      "[ROOT] Statusupdates eingerichtet",
      statusBody(status, "Die Statusupdates sind eingerichtet.")
    );
    properties.setProperties({ initialSent: "1", lastMission: fingerprint });
    return;
  }
  if (fingerprint !== properties.getProperty("lastMission")) {
    MailApp.sendEmail(
      ROOT_RECIPIENT,
      missionSubject(mission),
      statusBody(status, "Eine ROOT-Aufgabe hat ihren Status geändert.")
    );
    properties.setProperty("lastMission", fingerprint);
    return;
  }

  const current = status.currentMission;
  if (current && current.directiveId) {
    const seenKey = `running:${current.directiveId}`;
    const firstSeen = Number(properties.getProperty(seenKey) || 0);
    if (!firstSeen) {
      properties.setProperty(seenKey, String(Date.now()));
    } else if (
      Date.now() - firstSeen >= 20 * 60 * 1000 &&
      properties.getProperty("progressSent") !== current.directiveId
    ) {
      MailApp.sendEmail(
        ROOT_RECIPIENT,
        "[ROOT] Aufgabe läuft noch",
        `ROOT arbeitet seit mindestens 20 Minuten an einer Aufgabe. Ein Ergebnis liegt noch nicht vor.\n\n${ROOT_WORKER_URL}`
      );
      properties.setProperty("progressSent", current.directiveId);
      return;
    }
  }

  const berlin = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    berlin.formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  const weekSlot = `${parts.year}-${parts.month}-${parts.day}`;
  if (
    parts.weekday === "Sun" &&
    Number(parts.hour) >= 18 &&
    properties.getProperty("lastWeekly") !== weekSlot
  ) {
    MailApp.sendEmail(
      ROOT_RECIPIENT,
      `[ROOT] Wochenstatus ${weekSlot}`,
      statusBody(
        status,
        "Wöchentlicher Status. Auch ohne neue Aufgabe bleibt die Überwachung aktiv."
      )
    );
    properties.setProperty("lastWeekly", weekSlot);
  }
}

function recordStatusFailure(properties, reason) {
  const failures = Number(properties.getProperty("fetchFailures") || 0) + 1;
  properties.setProperty("fetchFailures", String(failures));
  if (failures < 3 || properties.getProperty("outageNotified")) return;
  MailApp.sendEmail(
    ROOT_RECIPIENT,
    "[ROOT] Status derzeit nicht erreichbar",
    `Die Statusabfrage ist dreimal fehlgeschlagen (${reason}). Es wurden keine Zugangsdaten versendet. Ich melde die Wiederherstellung.\n\n${ROOT_WORKER_URL}`
  );
  properties.setProperty("outageNotified", "1");
}

function missionSubject(mission) {
  if (!mission) return "[ROOT] Status geändert";
  if (mission.status === "FAILED") return "[ROOT] Aufgabe fehlgeschlagen";
  if (mission.status === "HUMAN_GATE_REQUIRED")
    return "[ROOT] Aufgabe geprüft – Freigabe vorgeschlagen";
  if (mission.status === "PARTIAL")
    return "[ROOT] Aufgabe teilweise abgeschlossen";
  return "[ROOT] Aufgabe abgeschlossen";
}

function statusBody(status, lead) {
  const mission = status.lastMission || null;
  const lines = [
    lead,
    `Projekt: ${status.programId || "unbekannt"}`,
    `Strategieentscheidung: ${status.lastDecision || "unbekannt"}`,
    `Aktive Aufgabe: ${status.currentMission ? "ja" : "nein"}`
  ];
  const drafts = status.musicDrafts || [];
  lines.push(`Gespeicherte Musikentwürfe: ${drafts.length}`);
  if (drafts.length)
    lines.push(
      `Neuester Entwurf: ${String(drafts[0].kind || "Entwurf")} – ${String(drafts[0].title || "").slice(0, 160)}`
    );
  if (mission) {
    lines.push(`Letzte Aufgabe: ${mission.status}`);
    lines.push(`Ergebnis: ${String(mission.summary || "").slice(0, 1800)}`);
    lines.push(`Belege: ${Number(mission.evidenceCount || 0)}`);
    if (mission.providerFailures && mission.providerFailures.length)
      lines.push(`Technische Fehler: ${mission.providerFailures.join(", ")}`);
    if (mission.humanGates && mission.humanGates.length)
      lines.push(
        `Vorgeschlagene Freigabe (noch nicht ausgeführt): ${String(mission.humanGates[0].proposedAction || "").slice(0, 400)}`
      );
  }
  lines.push(`ROOT: ${ROOT_WORKER_URL}`);
  return lines.join("\n\n");
}
