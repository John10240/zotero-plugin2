import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { SyncManager } from "./modules/syncManager";
import { S3Manager } from "./modules/s3Client";
import { config } from "../package.json";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preferences pane
  registerPrefsPane();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // Initialize S3 sync manager
  if (!addon.data.syncManager) {
    addon.data.syncManager = new SyncManager();
  }

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register S3 sync menu items
  registerS3SyncMenu();

  // Register S3 sync toolbar button (with delay to ensure toolbar is ready)
  setTimeout(() => {
    registerS3SyncButton(win);
  }, 1000);

  // Mark plugin as ready
  ztoolkit.log("S3 Sync plugin loaded successfully");
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is dispatcher for Notify events.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * This function is dispatcher for Preference UI events.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    case "testConnection":
      await testS3Connection();
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

function registerPrefsPane() {
  const prefOptions = {
    pluginID: addon.data.config.addonID,
    src: `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`,
    label: "Zotero S3 Sync",
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    defaultXUL: true,
  };

  Zotero.PreferencePanes.register(prefOptions);
  ztoolkit.log("Preferences pane registered");
}

function registerS3SyncMenu() {
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: "zotero-s3sync-sync",
    label: getString("menuitem-sync-s3"),
    commandListener: () => {
      if (addon.data.syncManager) {
        addon.data.syncManager.syncAttachments();
      }
    },
  });
}

async function testS3Connection() {
  const s3Manager = new S3Manager();

  if (!s3Manager.isConfigured()) {
    new ztoolkit.ProgressWindow("S3 Connection Test", { closeOnClick: true })
      .createLine({
        text: "S3 not configured. Please fill in all required fields.",
        type: "error",
      })
      .show(-1);
    return;
  }

  const progressWindow = new ztoolkit.ProgressWindow("S3 Connection Test", {
    closeOnClick: true,
  })
    .createLine({
      text: "Testing connection...",
      type: "default",
      progress: 50,
    })
    .show();

  const success = await s3Manager.testConnection();

  if (success) {
    progressWindow.changeLine({
      text: "Connection successful!",
      type: "success",
      progress: 100,
    });
  } else {
    progressWindow.changeLine({
      text: "Connection failed. Please check your settings.",
      type: "error",
      progress: 0,
    });
  }

  progressWindow.startCloseTimer(3000);
}

function registerS3SyncButton(win: _ZoteroTypes.MainWindow) {
  try {
    const doc = win.document;
    ztoolkit.log("Registering S3 sync button...");
    ztoolkit.log("Window location:", win.location.href);
    ztoolkit.log("Document readyState:", doc.readyState);

    // Log all available toolbars for debugging
    const allToolbars = doc.getElementsByTagName("toolbar");
    ztoolkit.log(`Total toolbar elements found: ${allToolbars.length}`);
    for (let i = 0; i < allToolbars.length; i++) {
      const tb = allToolbars[i];
      ztoolkit.log(`Toolbar ${i}: id="${tb.id}", class="${tb.className}"`);
    }

    // Try to find the official sync button to understand DOM structure
    const syncButton = doc.querySelector("#zotero-tb-sync");
    if (syncButton) {
      ztoolkit.log("Found official sync button");
      ztoolkit.log(
        "Sync button parent:",
        syncButton.parentElement?.tagName,
        syncButton.parentElement?.id,
      );
      ztoolkit.log(
        "Sync button parent's parent:",
        syncButton.parentElement?.parentElement?.tagName,
        syncButton.parentElement?.parentElement?.id,
      );
    } else {
      ztoolkit.log(
        "Official sync button not found with selector #zotero-tb-sync",
      );
    }

    // Create toolbar button using createXULElement
    const button = doc.createXULElement("toolbarbutton");
    button.id = "zotero-tb-s3sync";
    button.setAttribute("class", "zotero-tb-button");
    button.setAttribute("tooltiptext", "S3 云同步");
    // Use plugin's own icon
    button.setAttribute(
      "style",
      `list-style-image: url('chrome://${config.addonRef}/content/icons/favicon.png')`,
    );

    button.addEventListener("command", async () => {
      if (addon.data.syncManager) {
        button.setAttribute("tooltiptext", "S3 同步中...");
        button.setAttribute("disabled", "true");
        button.setAttribute(
          "style",
          "list-style-image: url('chrome://zotero/skin/spinner-16px.png')",
        );

        await addon.data.syncManager.syncAttachments();

        button.setAttribute("tooltiptext", "S3 云同步");
        button.removeAttribute("disabled");
        button.setAttribute(
          "style",
          `list-style-image: url('chrome://${config.addonRef}/content/icons/favicon.png')`,
        );
      }
    });

    // Try multiple possible toolbar locations
    const toolbarSelectors = [
      "#zotero-toolbar",
      "#zotero-items-toolbar",
      "#zotero-pane-toolbar",
      "toolbar[id='zotero-toolbar']",
      "#zotero-collections-toolbar",
      "#zotero-items-pane-content toolbar",
      "toolbar",
    ];

    let toolbar = null;
    for (const selector of toolbarSelectors) {
      toolbar = doc.querySelector(selector);
      if (toolbar) {
        ztoolkit.log(`Found toolbar with selector: ${selector}`);
        break;
      }
    }

    if (!toolbar && allToolbars.length > 0) {
      // Use first toolbar as fallback
      toolbar = allToolbars[0] as Element;
      ztoolkit.log(`Using first toolbar element: id="${(toolbar as any).id}"`);
    }

    if (toolbar) {
      // Try to add after sync button
      if (syncButton && syncButton.nextSibling) {
        toolbar.insertBefore(button, syncButton.nextSibling);
        ztoolkit.log("S3 sync button added after official sync button");
      } else if (syncButton) {
        syncButton.parentNode?.appendChild(button);
        ztoolkit.log("S3 sync button added to sync button's parent");
      } else {
        toolbar.appendChild(button);
        ztoolkit.log("S3 sync button added to toolbar (sync button not found)");
      }
      ztoolkit.log("Button successfully added to DOM");
    } else {
      ztoolkit.log("No toolbar found, cannot add button");
    }
  } catch (error) {
    ztoolkit.log("Error registering S3 sync button:", error);
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
