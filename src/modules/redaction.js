(function initChatVaultRedaction() {
  "use strict";

  // 内置正则表达式
  const RULES = {
    email: {
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g,
      replacement: "[REDACTED: EMAIL]"
    },
    phone: {
      // 匹配带国际区号的 8-15 位号码，以及常见 10 位/中国大陆 11 位格式。
      // 两侧禁止紧邻数字，避免从时间戳、卡号、订单号尾部截取 10/11 位误脱敏。
      regex: /(?<!\d)\+(?:[().\s-]?\d){8,15}(?!\d)|(?<!\d)\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)|(?<!\d)1[3-9]\d{9}(?!\d)/g,
      replacement: "[REDACTED: PHONE]"
    },
    api_key: {
      // 仅匹配明确前缀或明确凭据字段后的 token，避免误伤 MD5、Git SHA 等普通长串。
      regex: /\b(sk-[a-zA-Z0-9]{32,128}|ghp_[a-zA-Z0-9]{36,255}|github_pat_[a-zA-Z0-9_]{40,255})\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|secret|password|passwd|token|key)([\s=:\'\"#\-]+)([a-zA-Z0-9_\-.]{16,128})/gi,
      replacement: "[REDACTED: API_KEY]"
    },
    credit_card_like: {
      // 先收集 13-19 位候选，再通过 Luhn、重复数字和卡组织前缀校验降低误伤。
      // 带分隔符的号码也支持 4-6-5（Amex）等非 4-4-4-4 分组。
      regex: /(?<!\d)(?:\d[ .-]?){12,18}\d(?!\d)/g,
      replacement: "[REDACTED: CREDIT_CARD]",
      validate: isPlausiblePaymentCard
    },
    sensitive_url_param: {
      // 匹配 URL 中诸如 token=xxx，secret=xxx 的查询参数
      regex: /(?<=[?&])((?:token|key|secret|password|session|auth|access_token)=)([a-zA-Z0-9_\-\.\%]{8,128})/gi,
      replacement: "REDACTED_PARAM"
    }
  };

  function luhnValid(match) {
    // Luhn 校验：提取所有数字，按位加权求和，能被 10 整除即为有效卡号
    const digits = String(match || "").replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = parseInt(digits.charAt(i), 10);
      if (shouldDouble) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  function hasKnownCardPrefix(digits) {
    if (/^4/.test(digits)) return true; // Visa
    if (/^(?:34|37)/.test(digits)) return true; // American Express
    if (/^62/.test(digits)) return true; // UnionPay
    if (/^3(?:0[0-5]|[68])/.test(digits)) return true; // Diners Club

    const firstTwo = Number(digits.slice(0, 2));
    const firstFour = Number(digits.slice(0, 4));
    const firstSix = Number(digits.slice(0, 6));
    if ((firstTwo >= 51 && firstTwo <= 55) || (firstFour >= 2221 && firstFour <= 2720)) {
      return true; // Mastercard
    }
    if (
      digits.startsWith("6011")
      || firstTwo === 65
      || (firstFour >= 6440 && firstFour <= 6499)
      || (firstSix >= 622126 && firstSix <= 622925)
    ) {
      return true; // Discover
    }
    return firstFour >= 3528 && firstFour <= 3589; // JCB
  }

  function isPlausiblePaymentCard(match) {
    const candidate = String(match || "").trim();
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    if (/^(\d)\1+$/.test(digits) || !luhnValid(digits)) return false;

    if (/[ .-]/.test(candidate)) {
      const groups = candidate.split(/[ .-]+/);
      return groups.length >= 3 && groups.every((group) => /^\d{3,6}$/.test(group));
    }
    return hasKnownCardPrefix(digits);
  }

  function redactText(text, options, summary) {
    if (!text || typeof text !== "string") {
      return text;
    }

    let result = text;

    // 1. 应用内置规则
    Object.keys(RULES).forEach((ruleKey) => {
      const rule = RULES[ruleKey];

      if (ruleKey === "sensitive_url_param") {
        result = result.replace(rule.regex, (match, paramNameWithEquals, paramValue) => {
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          return paramNameWithEquals + rule.replacement;
        });
      } else if (ruleKey === "api_key") {
        result = result.replace(rule.regex, (match, prefixedKey, separator, value) => {
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          if (separator && value) {
            return match.slice(0, match.length - String(value).length) + rule.replacement;
          }
          return rule.replacement;
        });
      } else {
        result = result.replace(rule.regex, (match) => {
          // validate 钩子（如信用卡 Luhn 校验）失败则保留原文，避免误脱敏
          if (typeof rule.validate === "function" && !rule.validate(match)) {
            return match;
          }
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          return rule.replacement;
        });
      }
    });

    // 2. 应用自定义规则 (仅 Pro)
    if (Array.isArray(options?.customRules)) {
      options.customRules.forEach((rule) => {
        if (!rule || !rule.enabled || !rule.pattern) return;
        try {
          const regex = new RegExp(rule.pattern, "gi");
          const replacement = rule.replacement || "[REDACTED]";
          result = result.replace(regex, (match) => {
            summary.totalMatches++;
            const label = rule.id || rule.label || "custom";
            summary.byType[label] = (summary.byType[label] || 0) + 1;
            return replacement;
          });
        } catch (e) {
          console.warn("Invalid custom rule pattern:", rule.pattern, e);
        }
      });
    }

    return result;
  }

  function redactMessages(messages, options = {}) {
    const enabled = options.redaction_enabled !== false;
    const redactCode = options.redactCodeBlocks !== false;
    
    // 如果没有启用脱敏，直接返回原引用（不做修改）
    if (!enabled) {
      return {
        messages: messages || [],
        summary: { enabled: false, totalMatches: 0, byType: {} }
      };
    }

    // 深拷贝是必要的：脱敏会修改消息内容，避免污染原始数据
    const cloned = JSON.parse(JSON.stringify(messages || []));
    const summary = {
      enabled: true,
      totalMatches: 0,
      byType: {}
    };

    cloned.forEach((msg) => {
      if (Array.isArray(msg.contentBlocks)) {
        msg.contentBlocks.forEach((block) => {
          if (!block) return;
          
          if (block.type === "code") {
            if (redactCode && typeof block.text === "string") {
              block.text = redactText(block.text, options, summary);
            }
          } else if (typeof block.text === "string") {
            block.text = redactText(block.text, options, summary);
          }

          if (block.type === "image" && typeof block.alt === "string") {
            block.alt = redactText(block.alt, options, summary);
          }
        });
      }

      if (msg.exportMeta && typeof msg.exportMeta === "object") {
        Object.keys(msg.exportMeta).forEach((key) => {
          if (typeof msg.exportMeta[key] === "string") {
            msg.exportMeta[key] = redactText(msg.exportMeta[key], options, summary);
          }
        });
      }
    });

    return {
      messages: cloned,
      summary: summary
    };
  }

  globalThis.CHATVAULT_REDACTION = {
    redactMessages,
    _test: {
      redactText
    }
  };
})();
