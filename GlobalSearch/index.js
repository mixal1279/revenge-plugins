// GlobalSearch — plugin dla Revenge (Vendetta/Bunny spec)
// Dodaje ikonę lupy w dolnym navbarze. Po kliknięciu otwiera modal
// z polem wyszukiwania, które przeszukuje wszystkie serwery przez Discord API.

(function () {
  "use strict";

  // ─── Revenge Classic API globals ─────────────────────────────────────────
  const { findByProps, findByName } = vendetta.metro;
  const { after } = vendetta.patcher;
  const { React, ReactNative: RN } = vendetta.metro.common;
  const { getToken } = findByProps("getToken") ?? {};
  const GuildStore = findByProps("getGuilds", "getGuild");
  const ChannelStore = findByProps("getChannel", "getDMFromUserId");
  const { Text, View, TextInput, FlatList, Modal, ActivityIndicator, StyleSheet, TouchableOpacity } = RN;

  // Discord colors
  const DC = {
    bg: "#313338",
    surface: "#2b2d31",
    surface2: "#1e1f22",
    border: "#3f4147",
    accent: "#5865f2",
    text: "#dbdee1",
    muted: "#80848e",
    green: "#3ba55d",
    red: "#ed4245",
    yellow: "#faa61a",
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.75)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: DC.bg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 8,
      maxHeight: "90%",
      minHeight: "70%",
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: DC.border,
      borderRadius: 2,
      alignSelf: "center",
      marginBottom: 12,
    },
    title: {
      color: DC.text,
      fontWeight: "700",
      fontSize: 16,
      textAlign: "center",
      marginBottom: 12,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: DC.surface2,
      borderRadius: 10,
      marginHorizontal: 12,
      marginBottom: 10,
      paddingHorizontal: 12,
      paddingVertical: 2,
    },
    searchInput: {
      flex: 1,
      color: DC.text,
      fontSize: 14,
      paddingVertical: 10,
      fontFamily: "monospace",
    },
    searchBtn: {
      backgroundColor: DC.accent,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginLeft: 8,
    },
    searchBtnText: {
      color: "#fff",
      fontWeight: "700",
      fontSize: 13,
    },
    statsText: {
      color: DC.muted,
      fontSize: 11,
      marginHorizontal: 12,
      marginBottom: 6,
      fontFamily: "monospace",
    },
    emptyBox: {
      alignItems: "center",
      paddingVertical: 48,
    },
    emptyText: {
      color: DC.muted,
      fontSize: 13,
      fontFamily: "monospace",
    },
    loader: {
      paddingVertical: 32,
    },
    card: {
      backgroundColor: DC.surface,
      marginHorizontal: 12,
      marginVertical: 4,
      borderRadius: 10,
      padding: 12,
      borderLeftWidth: 3,
      borderLeftColor: DC.accent,
    },
    cardMeta: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 6,
      flexWrap: "wrap",
      gap: 4,
    },
    serverBadge: {
      backgroundColor: DC.accent + "33",
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    serverBadgeText: {
      color: DC.accent,
      fontSize: 10,
      fontWeight: "700",
    },
    channelText: {
      color: DC.muted,
      fontSize: 11,
      fontFamily: "monospace",
    },
    authorText: {
      color: DC.yellow,
      fontSize: 11,
      fontWeight: "600",
    },
    timeText: {
      color: DC.muted,
      fontSize: 10,
      marginLeft: "auto",
    },
    msgText: {
      color: DC.text,
      fontSize: 13,
      lineHeight: 18,
    },
    highlight: {
      backgroundColor: DC.yellow + "44",
      color: DC.yellow,
      fontWeight: "700",
    },
    jumpBtn: {
      marginTop: 8,
      alignSelf: "flex-end",
      borderWidth: 1,
      borderColor: DC.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    jumpBtnText: {
      color: DC.muted,
      fontSize: 11,
    },
    errorText: {
      color: DC.red,
      fontSize: 12,
      marginHorizontal: 12,
      marginBottom: 8,
      fontFamily: "monospace",
    },
    progressRow: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: 12,
      marginBottom: 8,
      gap: 8,
    },
    progressBarBg: {
      flex: 1,
      height: 3,
      backgroundColor: DC.border,
      borderRadius: 2,
      overflow: "hidden",
    },
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function formatTime(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffH = (now - d) / 3600000;
      if (diffH < 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (diffH < 48) return "wczoraj";
      return d.toLocaleDateString();
    } catch {
      return "";
    }
  }

  // FIX: Regex z flagą /g ma stateful lastIndex — tworzymy nowy RegExp per-test
  // zamiast wielokrotnie używać tego samego obiektu.
  function HighlightText({ text, query, style }) {
    if (!query || !text) return React.createElement(Text, { style }, text);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(re);
    return React.createElement(
      Text,
      { style },
      ...parts.map((p, i) =>
        new RegExp(escaped, "gi").test(p)
          ? React.createElement(Text, { key: i, style: styles.highlight }, p)
          : p
      )
    );
  }

  // ─── Discord REST search ──────────────────────────────────────────────────

  async function searchGuild(token, guildId, guildName, query, signal, onResult) {
    let attempts = 0;
    while (attempts < 4) {
      if (signal?.aborted) return;
      try {
        const url = `https://discord.com/api/v9/guilds/${guildId}/messages/search?content=${encodeURIComponent(query)}&limit=25`;
        const res = await fetch(url, {
          headers: { Authorization: token },
          signal,
        });
        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const wait = Math.min((data.retry_after ?? 1) * 1000, 8000);
          await new Promise((r) => setTimeout(r, wait));
          attempts++;
          continue;
        }
        if (res.status === 202) {
          // indeks jeszcze się buduje — spróbuj za chwilę
          await new Promise((r) => setTimeout(r, 2000));
          attempts++;
          continue;
        }
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        const msgs = (data.messages ?? []).map((group) => group[0]).filter(Boolean);
        if (msgs.length > 0) {
          msgs.forEach((m) => {
            m._guildName = guildName;
            m._guildId = guildId;
          });
          onResult(msgs); // live update — od razu pokazuj wyniki
        }
        return;
      } catch (e) {
        if (signal?.aborted) return;
        attempts++;
      }
    }
  }

  // ─── Główny komponent modal ───────────────────────────────────────────────

  function GlobalSearchModal({ visible, onClose }) {
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [progress, setProgress] = React.useState({ done: 0, total: 0 });
    const [error, setError] = React.useState(null);
    const abortRef = React.useRef(null);

    React.useEffect(() => {
      return () => abortRef.current?.abort();
    }, []);

    // Budujemy mapę guildId → guildName z GuildStore
    const guilds = React.useMemo(() => {
      try {
        return Object.values(GuildStore?.getGuilds?.() ?? {});
      } catch {
        return [];
      }
    }, []);

    async function runSearch() {
      if (!query.trim()) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setResults([]);
      setError(null);
      setProgress({ done: 0, total: guilds.length });

      const token = getToken?.();
      if (!token) {
        setError("Nie można pobrać tokena Discord. Zrestartuj apkę.");
        setLoading(false);
        return;
      }

      let done = 0;

      // Callback wywoływany na bieżąco gdy serwer zwróci wyniki — live update
      function onResult(msgs) {
        setResults((prev) => {
          const merged = [...prev, ...msgs];
          merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          return merged;
        });
      }

      function onDone() {
        done++;
        setProgress({ done, total: guilds.length });
      }

      // Wszystkie serwery startują równolegle od razu.
      // Rate limiting obsługuje searchGuild wewnętrznie przez retry z backoff.
      await Promise.allSettled(
        guilds.map(async (g) => {
          await searchGuild(token, g.id, g.name, query.trim(), controller.signal, onResult);
          onDone();
        })
      );

      if (!controller.signal.aborted) setLoading(false);
    }

    function handleClose() {
      abortRef.current?.abort();
      setQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
      onClose?.();
    }

    function renderItem({ item: msg }) {
      // FIX: pobieramy nazwę kanału z ChannelStore zamiast wyświetlać surowe ID
      const channelName = ChannelStore?.getChannel?.(msg.channel_id)?.name ?? msg.channel_id;

      return React.createElement(
        View,
        { style: styles.card, key: msg.id },
        // Meta wiersz
        React.createElement(
          View,
          { style: styles.cardMeta },
          React.createElement(
            View,
            { style: styles.serverBadge },
            React.createElement(Text, { style: styles.serverBadgeText }, msg._guildName ?? "Nieznany serwer")
          ),
          React.createElement(Text, { style: styles.channelText }, `#${channelName}`),
          React.createElement(Text, { style: styles.authorText }, msg.author?.username ?? "?"),
          React.createElement(Text, { style: styles.timeText }, formatTime(msg.timestamp))
        ),
        // Treść wiadomości z podświetleniem
        React.createElement(HighlightText, {
          text: msg.content || "(brak tekstu)",
          query: query.trim(),
          style: styles.msgText,
        }),
        // Przycisk skoku
        React.createElement(
          TouchableOpacity,
          {
            style: styles.jumpBtn,
            onPress: () => {
              handleClose();
              // Nawigacja do kanału i wiadomości przez Discord internals
              try {
                const { transitionToGuildSync } = findByProps("transitionToGuildSync") ?? {};
                const { selectChannel } = findByProps("selectChannel") ?? {};
                transitionToGuildSync?.(msg._guildId, msg.channel_id, msg.id);
                selectChannel?.({ channelId: msg.channel_id, guildId: msg._guildId, messageId: msg.id });
              } catch (e) {
                console.warn("[GlobalSearch] jump error:", e);
              }
            },
          },
          React.createElement(Text, { style: styles.jumpBtnText }, "↗ Idź do wiadomości")
        )
      );
    }

    const progressPct = progress.total > 0 ? progress.done / progress.total : 0;

    return React.createElement(
      Modal,
      {
        visible,
        transparent: true,
        animationType: "slide",
        onRequestClose: handleClose,
      },
      React.createElement(
        TouchableOpacity,
        { style: styles.overlay, activeOpacity: 1, onPress: handleClose },
        React.createElement(
          TouchableOpacity,
          { style: styles.sheet, activeOpacity: 1 },
          // Uchwyt
          React.createElement(View, { style: styles.handle }),
          // Tytuł
          React.createElement(Text, { style: styles.title }, "🔍 GlobalSearch"),
          // Pole wyszukiwania
          React.createElement(
            View,
            { style: styles.searchRow },
            React.createElement(TextInput, {
              style: styles.searchInput,
              placeholder: "wpisz słowo kluczowe…",
              placeholderTextColor: DC.muted,
              value: query,
              onChangeText: setQuery,
              onSubmitEditing: runSearch,
              returnKeyType: "search",
              autoFocus: true,
              editable: !loading,
            }),
            React.createElement(
              TouchableOpacity,
              { style: styles.searchBtn, onPress: runSearch, disabled: loading },
              React.createElement(Text, { style: styles.searchBtnText }, loading ? "…" : "Szukaj")
            )
          ),
          // Error
          error && React.createElement(Text, { style: styles.errorText }, "❌ " + error),
          // Loading + progress
          loading &&
            React.createElement(
              View,
              { style: styles.progressRow },
              React.createElement(ActivityIndicator, { size: "small", color: DC.accent }),
              React.createElement(
                View,
                { style: styles.progressBarBg },
                React.createElement(View, {
                  style: {
                    height: 3,
                    width: `${(progressPct * 100).toFixed(0)}%`,
                    backgroundColor: DC.accent,
                    borderRadius: 2,
                  },
                })
              ),
              React.createElement(
                Text,
                { style: [styles.channelText, { minWidth: 60, textAlign: "right" }] },
                `${progress.done}/${progress.total} srv`
              )
            ),
          // Stats
          !loading &&
            results.length > 0 &&
            React.createElement(
              Text,
              { style: styles.statsText },
              `Znaleziono ${results.length} wyników na ${guilds.length} serwerach`
            ),
          // Lista wyników lub empty state
          React.createElement(FlatList, {
            data: results,
            keyExtractor: (item) => item.id,
            renderItem,
            ListEmptyComponent: !loading
              ? React.createElement(
                  View,
                  { style: styles.emptyBox },
                  React.createElement(
                    Text,
                    { style: styles.emptyText },
                    query ? "Brak wyników." : "Wpisz frazę i kliknij Szukaj."
                  )
                )
              : null,
            contentContainerStyle: { paddingBottom: 32 },
          })
        )
      )
    );
  }

  // ─── Navbar button ────────────────────────────────────────────────────────

  let patches = [];
  let modalVisible_state = { value: false, setter: null };

  // Globalny root overlay dla modala
  function GlobalSearchRoot() {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
      modalVisible_state.setter = setVisible;
      return () => { modalVisible_state.setter = null; };
    }, []);
    return React.createElement(GlobalSearchModal, { visible, onClose: () => setVisible(false) });
  }

  // ─── Plugin lifecycle ─────────────────────────────────────────────────────

  function start() {
    const candidates = [
      "App", "AppRoot", "AppView", "DiscordApp",
      "Router", "RootNavigator", "Navigation",
      "LayerScene", "LayerContainer",
    ];

    let found = [];
    for (const name of candidates) {
      const m = findByName(name, { default: false });
      if (m) found.push(name);
    }

    // Toast diagnostyczny — bezpieczny format
    try {
      const Toasts = findByProps("open", "close") ?? findByProps("showToast");
      const toastFn = Toasts?.open ?? Toasts?.showToast;
      if (toastFn) {
        toastFn({
          content: "[GS] Found: " + (found.length ? found.join(", ") : "nic"),
        });
      }
    } catch (e) {
      console.warn("[GlobalSearch] toast error:", e);
    }

    // FIX: przerywamy po pierwszym udanym patchu — zapobiega
    // wielokrotnemu renderowaniu GlobalSearchRoot i FAB na ekranie.
    for (const name of candidates) {
      const m = findByName(name);
      if (!m) continue;

      const target = typeof m === "function" ? m : m.default ?? m;
      if (!target?.prototype?.render && typeof target !== "function") continue;

      try {
        const p = after("render", target.prototype ?? target, (_args, res) => {
          if (!res) return res;
          return React.createElement(
            View,
            { style: { flex: 1 } },
            res,
            React.createElement(GlobalSearchRoot, { key: "gs-root" }),
            React.createElement(
              TouchableOpacity,
              {
                key: "gs-fab",
                onPress: () => modalVisible_state.setter?.(true),
                style: {
                  position: "absolute",
                  bottom: 90,
                  right: 16,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: DC.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  elevation: 10,
                },
              },
              React.createElement(Text, { style: { fontSize: 22 } }, "🔍")
            )
          );
        });
        patches.push(p);
        // FIX: jeden patch wystarczy — przerywamy pętlę
        console.log("[GlobalSearch] patched:", name);
        break;
      } catch (e) {
        // ten kandydat nie zadziałał, próbuj następnego
        console.warn("[GlobalSearch] patch failed for:", name, e);
      }
    }

    console.log("[GlobalSearch] started, patches:", patches.length);
  }

  function stop() {
    patches.forEach((p) => p?.());
    patches = [];
    console.log("[GlobalSearch] plugin stopped");
  }

  // ─── Eksport dla Revenge/Bunny ────────────────────────────────────────────
  module.exports = { start, stop };
})();
