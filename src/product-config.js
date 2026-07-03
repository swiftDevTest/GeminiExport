(function initChatVaultProductConfig() {
  "use strict";

  const existing = globalThis.CHATVAULT_PRODUCT_CONFIG || {};

  const defaults = {
    productId: "gemini_export",
    productSlug: "gemini-export",
    productName: "Gemini Export",
    shortName: "Gemini Export",
    checkoutUrl: "https://tabpilotpro.com/gemini/checkout.html",
    checkoutBaseUrl: "https://tabpilotpro.com/gemini",
    storageNamespace: "gemini_export",
    isolatedMembership: true,
    supportedPlatforms: ["gemini"],
    platformLabels: {
      chatgpt: "ChatGPT",
      claude: "Claude",
      gemini: "Gemini"
    },
    allowedHosts: ["gemini.google.com"],
    theme: {
      primary: "#2563eb",
      primaryDark: "#1d4ed8",
      accent: "#14b8a6",
      wash: "#eaf1ff",
      soft: "#f3f6ff",
      border: "#bfccff"
    },
    billingPriceIds: {
      monthly: "",
      yearly: "",
      lifetime: ""
    }
  };

  const config = {
    ...defaults,
    ...existing,
    platformLabels: {
      ...defaults.platformLabels,
      ...(existing.platformLabels || {})
    },
    theme: {
      ...defaults.theme,
      ...(existing.theme || {})
    },
    billingPriceIds: {
      ...defaults.billingPriceIds,
      ...(existing.billingPriceIds || {})
    }
  };

  function storageKey(name) {
    return `${config.storageNamespace}.${name}`;
  }

  function hexToRgb(hex) {
    const normalized = String(hex || "").replace("#", "").trim();
    const fallback = String(defaults.theme.primary || "#2563eb").replace("#", "").trim();
    const candidate = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
    const value = Number.parseInt(candidate, 16);
    return [
      (value >> 16) & 255,
      (value >> 8) & 255,
      value & 255
    ].join(", ");
  }

  function getThemeVars() {
    const primary = config.theme.primary || defaults.theme.primary;
    const primaryDark = config.theme.primaryDark || defaults.theme.primaryDark;
    const accent = config.theme.accent || primary;
    return {
      "--primary-color": primary,
      "--primary-hover": primaryDark,
      "--success-color": primary,
      "--accent": primary,
      "--accent-strong": primaryDark,
      "--accent-ink": primaryDark,
      "--accent-wash": config.theme.wash || "rgba(" + hexToRgb(primary) + ", 0.12)",
      "--cv-primary": primary,
      "--cv-primary-hover": primaryDark,
      "--cv-accent": accent,
      "--cv-primary-rgb": hexToRgb(primary),
      "--cv-accent-rgb": hexToRgb(accent)
    };
  }

  function applyThemeVars(target) {
    const style = target && target.style;
    if (!style || typeof style.setProperty !== "function") return;
    const vars = getThemeVars();
    Object.keys(vars).forEach((name) => {
      style.setProperty(name, vars[name]);
    });
  }

  globalThis.CHATVAULT_PRODUCT_CONFIG = {
    ...config,
    storageKey,
    getThemeVars,
    applyThemeVars
  };
})();
