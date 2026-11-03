const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { ThreadPaneColumns } = ChromeUtils.importESModule(
  "chrome://messenger/content/ThreadPaneColumns.mjs"
);

const TERM_ID = "ipaddr2country@local.invalid#OriginCountry";
const TERM_NAME = "送信元IPの国 (Originating IP country)";
const COLUMN_ID = "ipCountryOriginCol";
const COLUMN_NAME = "送信元国";
const DATABASE_PATH = "data/ip-country.json";
const MAX_MESSAGE_COUNTRY_CACHE = 50000;
let countryRanges;
const messageCountryCache = new Map();
let windowWatcher;
const searchValueObservers = new Set();
const searchDialogColumnViews = new WeakSet();
const searchDialogColumnWindows = new WeakSet();
let headerReadWarningLogged = false;
let registeredTermAvailable = false;
let countryColumnRegistered = false;
let columnRegistrationTimer;
let activeSearchMetrics;

function addCountryInput(searchValue) {
  if (
    searchValue.localName !== "hbox" ||
    !searchValue.classList.contains("search-value-custom") ||
    searchValue.getAttribute("searchAttribute") !== TERM_ID ||
    searchValue.querySelector("input[data-ip-country-value]")
  ) {
    return;
  }

  const input = searchValue.ownerDocument.createElement("input");
  input.type = "text";
  input.className = "input-inline search-value-input";
  input.setAttribute("data-ip-country-value", "true");
  input.setAttribute("placeholder", "国コード (例: jp)");
  input.style.flex = "1";
  input.style.minWidth = "0";
  input.value = searchValue.getAttribute("value") ?? "";
  input.addEventListener("input", () => {
    searchValue.setAttribute("value", input.value);
  });
  searchValue.appendChild(input);

  const observer = new searchValue.ownerDocument.defaultView.MutationObserver(() => {
    const currentValue = searchValue.getAttribute("value") ?? "";
    if (input.value !== currentValue) {
      input.value = currentValue;
    }
  });
  observer.observe(searchValue, { attributes: true, attributeFilter: ["value"] });
  searchValueObservers.add(observer);
}

function installSearchValueInputs(win) {
  const attach = () => {
    const doc = win.document;
    if (!doc?.documentElement) {
      return;
    }
    const scan = () => {
      for (const searchValue of doc.querySelectorAll(
        `.search-value-custom[searchAttribute="${TERM_ID}"]`
      )) {
        addCountryInput(searchValue);
      }
    };
    scan();
    const observer = new win.MutationObserver(scan);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    searchValueObservers.add(observer);
  };

  if (win.document?.readyState === "complete") {
    attach();
  } else {
    win.addEventListener("load", attach, { once: true });
  }
}

function isSearchDialog(win) {
  return /(?:^|\/)searchDialog\.xhtml(?:$|[?#])/i.test(
    win.document?.documentURI ?? ""
  );
}

function addSearchDialogCountryCell(win) {
  const doc = win.document;
  const rowTemplate = doc?.getElementById("threadPaneRowTemplate");
  const row = rowTemplate?.content;
  if (!row) {
    return false;
  }
  if (row.querySelector(`.${COLUMN_ID.toLowerCase()}-column`)) {
    return true;
  }

  // SearchDialog shares the message-list column definitions, but has its own
  // row template. Add the matching cell before its init/updateColumns runs.
  const cell = doc.createElement("td");
  // SearchDialog looks cells up by `column.id.toLowerCase() + "-column"`.
  cell.classList.add(`${COLUMN_ID.toLowerCase()}-column`);
  // Tree rows use lowercase column ids in data-column-name, matching the
  // cells created by the built-in about:3pane custom-column path.
  cell.setAttribute("data-column-name", COLUMN_ID.toLowerCase());
  row.appendChild(cell);
  console.info("IP Country Filter added its column cell to the search-results template.");
  return true;
}

function prepareOpenSearchDialogs() {
  const windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    if (isSearchDialog(win)) {
      addSearchDialogCountryCell(win);
      scheduleSearchDialogColumnHandler(win);
    }
  }
}

function installSearchDialogColumnHandler(win) {
  if (!isSearchDialog(win)) {
    return false;
  }
  const threadTree = win.document.getElementById("threadTree");
  let view;
  try {
    // The search dialog replaces the tree view when its synthetic search view
    // opens. Prefer the exact view currently attached to the result tree.
    view = threadTree?.view ?? win.gDBView;
  } catch (error) {
    // The search dialog defines gDBView before its folder display is ready.
    return false;
  }
  if (!view || searchDialogColumnViews.has(view)) {
    return Boolean(view);
  }
  if (typeof view.addColumnHandler !== "function") {
    return false;
  }

  // SearchDialog uses a synthetic DB view. Its row template knows about the
  // custom column, but unlike the main message list it does not install the
  // custom column handler itself. Adapt the callback to the DBView row API.
  const column = ThreadPaneColumns.getColumn(COLUMN_ID);
  const handler = {
    ...column.handler,
    getCellText(row, col) {
      try {
        const msgHdr = typeof row === "number" ? view.getMsgHdrAt(row) : row;
        return getCountryColumnText(msgHdr);
      } catch (error) {
        console.error("IP Country Filter could not read a search-result row:", error);
        return "";
      }
    },
  };

  try {
    view.addColumnHandler(COLUMN_ID, handler);
    searchDialogColumnViews.add(view);
    threadTree?.reset();
    console.info("IP Country Filter attached its country handler to the search-results view.");
    return true;
  } catch (error) {
    console.warn("IP Country Filter could not attach its search-results column handler:", error);
    return false;
  }
}

function scheduleSearchDialogColumnHandler(win, attempts = 30) {
  if (!isSearchDialog(win) || win.closed || attempts <= 0) {
    return;
  }
  if (installSearchDialogColumnHandler(win)) {
    return;
  }
  win.setTimeout(() => scheduleSearchDialogColumnHandler(win, attempts - 1), 100);
}

function watchSearchDialogColumnView(win) {
  if (!isSearchDialog(win) || searchDialogColumnWindows.has(win)) {
    return;
  }
  const threadTree = win.document.getElementById("threadTree");
  if (!threadTree) {
    return;
  }
  searchDialogColumnWindows.add(win);
  threadTree.addEventListener("viewchange", () => {
    // The event is dispatched after the tree receives the newly opened view.
    win.setTimeout(() => scheduleSearchDialogColumnHandler(win), 0);
  });
}

function watchSearchWindows() {
  if (windowWatcher) {
    return;
  }
  windowWatcher = {
    observe(subject, topic) {
      if (topic === "domwindowopened") {
      subject.addEventListener(
        "DOMContentLoaded",
        () => {
          if (isSearchDialog(subject)) {
            addSearchDialogCountryCell(subject);
            watchSearchDialogColumnView(subject);
            scheduleSearchDialogColumnHandler(subject);
          }
        },
        { once: true }
      );
        subject.addEventListener(
          "load",
          () => {
            installSearchValueInputs(subject);
            watchSearchDialogColumnView(subject);
            scheduleSearchDialogColumnHandler(subject);
          },
          { once: true }
        );
      }
    },
  };
  Services.ww.registerNotification(windowWatcher);
  Services.obs.addObserver(searchDialogViewObserver, "MsgCreateDBView");
  const windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    installSearchValueInputs(win);
    if (isSearchDialog(win)) {
      watchSearchDialogColumnView(win);
      scheduleSearchDialogColumnHandler(win);
    }
  }
}

const searchDialogViewObserver = {
  observe() {
    const windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      if (isSearchDialog(win)) {
        watchSearchDialogColumnView(win);
        scheduleSearchDialogColumnHandler(win);
      }
    }
  },
};

function ipToInteger(value) {
  let ip = value.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/%.+$/, "");
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const octets = ip.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) {
      return null;
    }
    return { family: 4, value: octets.reduce((n, octet) => (n << 8n) | BigInt(octet), 0n) };
  }

  if (!ip.includes(":")) {
    return null;
  }
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  return {
    family: 6,
    value: groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n),
  };
}

function isPublicAddress(address) {
  const { family, value } = address;
  if (family === 4) {
    const a = Number((value >> 24n) & 255n);
    const b = Number((value >> 16n) & 255n);
    const c = Number((value >> 8n) & 255n);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const first = Number((value >> 112n) & 0xffffn);
  const second = Number((value >> 96n) & 0xffffn);
  const isLoopback = value === 1n;
  const isUnspecified = value === 0n;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && second === 0x0db8;
  const isMappedIPv4 = value >> 32n === 0xffffn;
  return !(isLoopback || isUnspecified || isUniqueLocal || isLinkLocal || isMulticast || isDocumentation || isMappedIPv4);
}

function findCountry(address) {
  const ranges = countryRanges?.[address.family];
  if (!ranges) {
    return null;
  }
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end, country] = ranges[middle];
    if (address.value < start) {
      high = middle - 1;
    } else if (address.value > end) {
      low = middle + 1;
    } else {
      return country;
    }
  }
  return null;
}

function countryFromReceived(headers) {
  const received = headers.match(/^Received\s*:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gim) ?? [];
  // Received fields are ordered newest first. Walk from the oldest hop towards the recipient.
  for (let index = received.length - 1; index >= 0; index--) {
    const line = received[index];
    const candidates = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{0,4}:[0-9a-f:.]{2,39}/gi) ?? [];
    for (const candidate of candidates) {
      const address = ipToInteger(candidate.replace(/[.,;)]$/, ""));
      if (address && isPublicAddress(address)) {
        const country = findCountry(address);
        if (country) {
          return country;
        }
      }
    }
  }
  return null;
}

function readRawMessageHeaders(msgHdr) {
  // Read only from Thunderbird's local message store. Streaming via the message
  // service can wait for a remote IMAP fetch, which blocks this synchronous
  // search callback and can make a search appear to never finish.
  const input = msgHdr.folder.getMsgInputStream(msgHdr);
  const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  scriptable.init(input);
  let raw = "";
  const maximumHeaderLength = 256 * 1024;
  try {
    while (raw.length < maximumHeaderLength) {
      const available = scriptable.available();
      if (!available) {
        break;
      }
      raw += scriptable.read(Math.min(available, 4096, maximumHeaderLength - raw.length));
      const separator = raw.search(/\r?\n\r?\n/);
      if (separator >= 0) {
        return raw.slice(0, separator);
      }
    }
  } finally {
    scriptable.close();
  }
  return raw;
}

function normalizeSearchValue(value) {
  return value.trim().toLowerCase();
}

function getMessageCountry(msgHdr) {
  const cacheKey = `${msgHdr.folder.URI}\u0000${msgHdr.messageKey}`;
  const metrics = activeSearchMetrics;
  if (messageCountryCache.has(cacheKey)) {
    const country = messageCountryCache.get(cacheKey);
    if (metrics) {
      metrics.cacheHits++;
    }
    // Refresh insertion order so frequently searched messages stay in the bounded cache.
    messageCountryCache.delete(cacheKey);
    messageCountryCache.set(cacheKey, country);
    return country;
  }

  if (metrics) {
    metrics.cacheMisses++;
  }
  let country = null;
  const readStartedAt = Date.now();
  let headers = "";
  try {
    headers = readRawMessageHeaders(msgHdr);
  } catch (error) {
    // Messages without a local/offline copy cannot be inspected synchronously.
    // Cache that result too, so repeated searches do not retry the same read.
    if (metrics) {
      metrics.errors++;
    }
    if (!headerReadWarningLogged) {
      headerReadWarningLogged = true;
      console.warn("IP Country Filter skipped messages without readable local headers:", error);
    }
  }
  const readDuration = Date.now() - readStartedAt;
  if (metrics) {
    metrics.headerReadMs += readDuration;
    metrics.maxHeaderReadMs = Math.max(metrics.maxHeaderReadMs, readDuration);
  }
  if (headers) {
    const parseStartedAt = Date.now();
    country = countryFromReceived(headers);
    if (metrics) {
      metrics.parseMs += Date.now() - parseStartedAt;
    }
  }
  messageCountryCache.set(cacheKey, country);
  if (messageCountryCache.size > MAX_MESSAGE_COUNTRY_CACHE) {
    messageCountryCache.delete(messageCountryCache.keys().next().value);
  }
  return country;
}

function getCountryColumnText(msgHdr) {
  try {
    return getMessageCountry(msgHdr)?.toUpperCase() ?? "";
  } catch (error) {
    console.error("IP Country Filter could not render the country column:", error);
    return "";
  }
}

function registerCountryColumn() {
  if (countryColumnRegistered) {
    return;
  }
  prepareOpenSearchDialogs();
  ThreadPaneColumns.addCustomColumn(COLUMN_ID, {
    name: COLUMN_NAME,
    hidden: false,
    icon: false,
    resizable: true,
    sortable: false,
    textCallback: getCountryColumnText,
  });
  countryColumnRegistered = true;
  console.info("IP Country Filter registered the sender-country message-list column.");
}

function hasReadyMailList() {
  const windows = Services.wm.getEnumerator("mail:3pane");
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    const pane = win.document?.getElementById("tabmail")?.currentAbout3Pane;
    if (pane?.gFolder && pane?.threadPane) {
      return true;
    }
  }
  return false;
}

function scheduleCountryColumnRegistration() {
  if (countryColumnRegistered || columnRegistrationTimer) {
    return;
  }
  columnRegistrationTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  columnRegistrationTimer.initWithCallback(
    {
      notify() {
        columnRegistrationTimer = undefined;
        if (countryColumnRegistered) {
          return;
        }
        if (!hasReadyMailList()) {
          scheduleCountryColumnRegistration();
          return;
        }
        try {
          registerCountryColumn();
        } catch (error) {
          console.error("IP Country Filter could not register the sender-country column:", error);
        }
      },
    },
    500,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
}

function logSearchMetrics(metrics, finished) {
  const elapsed = Date.now() - metrics.startedAt;
  console.info(
    `IP Country Filter ${finished ? "search finished" : "search progress"}: ` +
      `${metrics.messages} messages, ${metrics.cacheHits} cache hits, ` +
      `${metrics.cacheMisses} header reads, ${metrics.headerReadMs}ms reading headers ` +
      `(max ${metrics.maxHeaderReadMs}ms), ${metrics.parseMs}ms parsing, ` +
      `${metrics.matches} matches, ${metrics.errors} read errors, ${elapsed}ms elapsed.`
  );
}

function scheduleSearchSummary(metrics) {
  if (metrics.summaryTimer) {
    return;
  }
  metrics.summaryTimer = setTimeout(function checkForSearchEnd() {
    metrics.summaryTimer = null;
    if (activeSearchMetrics !== metrics) {
      return;
    }
    if (Date.now() - metrics.lastMatchAt >= 1500) {
      logSearchMetrics(metrics, true);
      activeSearchMetrics = null;
      return;
    }
    metrics.summaryTimer = setTimeout(checkForSearchEnd, 1500);
  }, 1500);
}

async function loadDatabase(extension) {
  if (countryRanges) {
    return;
  }
  const loadStartedAt = Date.now();
  console.info("IP Country Filter loading the bundled offline country database.");
  const uri = Services.io.newURI(extension.rootURI.resolve(DATABASE_PATH));
  const json = await new Promise((resolve, reject) => {
    NetUtil.asyncFetch({ uri, loadUsingSystemPrincipal: true }, (stream, status) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error(`Could not read bundled country database (nsresult ${status})`));
        return;
      }
      try {
        resolve(NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }));
      } catch (error) {
        reject(error);
      } finally {
        stream.close();
      }
    });
  });
  const readDuration = Date.now() - loadStartedAt;
  const parseStartedAt = Date.now();
  const data = JSON.parse(json);
  const parseJsonDuration = Date.now() - parseStartedAt;
  const indexStartedAt = Date.now();
  countryRanges = {
    4: data.ipv4.map(([start, end, code]) => [BigInt(start), BigInt(end), code.toLowerCase()]),
    6: data.ipv6.map(([start, end, code]) => [BigInt(`0x${start}`), BigInt(`0x${end}`), code.toLowerCase()]),
  };
  console.info(
    `IP Country Filter database ready: ${data.ipv4.length} IPv4 and ${data.ipv6.length} IPv6 ranges; ` +
      `${json.length} characters; ${readDuration}ms read, ${parseJsonDuration}ms JSON parse, ` +
      `${Date.now() - indexStartedAt}ms index conversion, ${Date.now() - loadStartedAt}ms total.`
  );
}

class IpCountryAPI extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      ipCountry: {
        async registerSearchTerm() {
          let stage = "loading the offline country database";
          try {
            await loadDatabase(context.extension);
            const Ci = Components.interfaces;
            const term = {
              id: TERM_ID,
              name: TERM_NAME,
              scope: Ci.nsMsgSearchScope.offlineMail,
              needsBody: false,
              getEnabled() {
                return registeredTermAvailable;
              },
              getAvailable(scope) {
                return registeredTermAvailable && scope !== Ci.nsMsgSearchScope.news;
              },
              getAvailableOperators() {
                return [Ci.nsMsgSearchOp.Is, Ci.nsMsgSearchOp.Isnt];
              },
              match(msgHdr, searchValue, searchOp) {
                try {
                  if (!activeSearchMetrics) {
                    activeSearchMetrics = {
                      startedAt: Date.now(),
                      lastMatchAt: Date.now(),
                      messages: 0,
                      cacheHits: 0,
                      cacheMisses: 0,
                      headerReadMs: 0,
                      maxHeaderReadMs: 0,
                      parseMs: 0,
                      matches: 0,
                      errors: 0,
                      summaryTimer: null,
                    };
                    console.info("IP Country Filter search started.");
                    scheduleSearchSummary(activeSearchMetrics);
                  }
                  activeSearchMetrics.messages++;
                  activeSearchMetrics.lastMatchAt = Date.now();
                  const country = getMessageCountry(msgHdr);
                  const expected = normalizeSearchValue(searchValue);
                  if (!country) {
                    if (activeSearchMetrics.messages % 1000 === 0) {
                      logSearchMetrics(activeSearchMetrics, false);
                    }
                    return false;
                  }
                  const matched = searchOp === Ci.nsMsgSearchOp.Isnt ? country !== expected : country === expected;
                  if (matched) {
                    activeSearchMetrics.matches++;
                  }
                  if (activeSearchMetrics.messages % 1000 === 0) {
                    logSearchMetrics(activeSearchMetrics, false);
                  }
                  return matched;
                } catch (error) {
                  if (activeSearchMetrics) {
                    activeSearchMetrics.errors++;
                  }
                  console.error("IP Country Filter could not inspect message headers:", error);
                  return false;
                }
              },
            };
            stage = "registering the Thunderbird filter condition";
            registeredTermAvailable = true;
            if (!MailServices.filters.getCustomTerm(TERM_ID)) {
              MailServices.filters.addCustomTerm(term);
            }
            scheduleCountryColumnRegistration();
            watchSearchWindows();
            return { ok: true };
          } catch (error) {
            const message = error?.message ?? String(error);
            const stack = error?.stack ?? "";
            console.error(`IP Country Filter failed while ${stage}: ${message}\n${stack}`);
            return { ok: false, stage, message, stack };
          }
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    // Thunderbird exposes no removeCustomTerm API. Hide the term immediately
    // from subsequently refreshed search menus while its registry object is
    // retained for the rest of this application session.
    registeredTermAvailable = false;
    if (activeSearchMetrics?.summaryTimer) {
      clearTimeout(activeSearchMetrics.summaryTimer);
    }
    activeSearchMetrics = null;
    columnRegistrationTimer?.cancel();
    columnRegistrationTimer = undefined;
    countryRanges = undefined;
    messageCountryCache.clear();
    if (countryColumnRegistered) {
      try {
        ThreadPaneColumns.removeCustomColumn(COLUMN_ID);
        countryColumnRegistered = false;
      } catch (error) {
        console.error("IP Country Filter could not remove the sender-country column:", error);
      }
    }
    if (windowWatcher) {
      Services.ww.unregisterNotification(windowWatcher);
      windowWatcher = undefined;
    }
    try {
      Services.obs.removeObserver(searchDialogViewObserver, "MsgCreateDBView");
    } catch (error) {
      // Observer may not have been registered if initialization failed early.
    }
    for (const observer of searchValueObservers) {
      observer.disconnect();
    }
    searchValueObservers.clear();
    if (!isAppShutdown) {
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  }
}

this.ipCountry = class extends IpCountryAPI {};

