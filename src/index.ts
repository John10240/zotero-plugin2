import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// Access the loadSubScript context
// When loadSubScript is called with a context object, that object becomes available
// We need to check if _globalThis is defined in the context
declare var _globalThis: any;

// Helper to get the global context
function getGlobalContext() {
  // If _globalThis is defined (by bootstrap.js), use it
  if (typeof _globalThis !== 'undefined') {
    return _globalThis;
  }
  // Otherwise, return a dummy object (this shouldn't happen in normal execution)
  return {};
}

const globalContext = getGlobalContext();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  globalContext.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return globalContext.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = globalContext.addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(globalContext, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
