// GlobalSearch — plugin dla Revenge (Vendetta/Bunny spec)
// Dodaje ikonę lupy w dolnym navbarze. Po kliknięciu otwiera modal
// z polem wyszukiwania, które przeszukuje wszystkie serwery przez Discord API.

(function () {
  "use strict";

  // ─── Revenge/Bunny API globals ────────────────────────────────────────────
  const { findByProps, findByName } = vendetta.metro;
  const { after, before, instead } = vendetta.patcher;
  const { React, ReactNative: RN } = vendetta.metro.common;
  const { showToast } = vendetta.metro.common.Toasts ?? {};
  const { getToken } = findByProps("getToken") ?? {};
  const GuildStore = findByProps("getGuilds", "getGuild");
  const NavigationNative = findByProps("NavigationNative", "NavigationContainer") ?? {};
  const Pressable = RN?.Pressable ?? RN?.TouchableOpacity;
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

  function HighlightText({ text, query, style }) {
    if (!query || !text) return React.createElement(Text, { style }, text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const parts = text.split(re);
    return React.createElement(
      Text,
      { style },
      ...parts.map((p, i) =>
        re.test(p)
          ? React.createElement(Text, { key: i, style: styles.highlight }, p)
          : p
      )
    );
  }

  // ─── Discord REST search ──────────────────────────────────────────────────
  // Używamy oficjalnego Discord Search API (tego samego co Ctrl+F na desktopie)

  async function searchGuild(token, guildId, query, signal) {
    const url = `https://discord.com/api/v9/guilds/${guildId}/messages/search?content=${encodeURIComponent(query)}&limit=25`;
    const res = await fetch(url, {
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      signal,
    });
    if (res.status === 429) {
      // rate limited — czekaj i spróbuj ponownie
      const data = await res.json().catch(() => ({}));
      const wait = (data.retry_after ?? 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return searchGuild(token, guildId, query, signal);
    }
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    // API zwraca { messages: [[msg, ...context]] } — bierzemy pierwszy msg z każdej grupy
    return (data.messages ?? []).map((group) => group[0]).filter(Boolean);
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

      const all = [];
      // Limit równoległości — max 3 naraz żeby nie dostać bana od rate limitera
      const CHUNK = 3;
      for (let i = 0; i < guilds.length; i += CHUNK) {
        if (controller.signal.aborted) break;
        const chunk = guilds.slice(i, i + CHUNK);
        const settled = await Promise.allSettled(
          chunk.map((g) => searchGuild(token, g.id, query.trim(), controller.signal))
        );
        settled.forEach((res, idx) => {
          if (res.status === "fulfilled" && res.value.length > 0) {
            res.value.forEach((msg) => {
              msg._guildName = chunk[idx].name;
              msg._guildId = chunk[idx].id;
            });
            all.push(...res.value);
          }
        });
        setProgress({ done: i + chunk.length, total: guilds.length });
        // Małe opóźnienie między chunkami żeby nie hammować API
        if (i + CHUNK < guilds.length) await new Promise((r) => setTimeout(r, 400));
      }

      // Posortuj od najnowszych
      all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setResults(all);
      setLoading(false);
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
          React.createElement(Text, { style: styles.channelText }, `#${msg.channel_id}`),
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
  // Patchujemy komponent dolnego paska (TabBar), dodając ikonę lupy.

  let patches = [];
  let modalVisible_state = { value: false, setter: null };

  // Globalny root overlay dla modala (prosty trick z dodaniem widoku do RootView)
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
    // 1) Znajdź TabBar Discord (dolny navbar)
    const TabBarModule = findByProps("useTabBarTabStyle") ?? findByName("TabBar");
    const BottomTabBar = findByProps("BottomTabBarIcon") ?? findByName("BottomTabBar");

    // 2) Wstrzyknij przycisk lupy do HeaderRight w głównym widoku lub do TabBar
    //    Najprostsze i najbardziej niezawodne: patch na komponent który renderuje
    //    prawy górny róg (header buttons)
    const HeaderRight = findByProps("useHeaderRightButtons") ?? findByProps("HeaderRight");

    if (HeaderRight) {
      const p = after("useHeaderRightButtons", HeaderRight, (args, res) => {
        // res to tablica przycisków — dodajemy nasz
        const searchButton = {
          key: "global-search",
          icon: "🔍",
          label: "Global Search",
          onPress: () => modalVisible_state.setter?.(true),
        };
        if (Array.isArray(res)) return [...res, searchButton];
        return res;
      });
      patches.push(p);
    }

    // 3) Alternatywnie — patch na komponent renderujący główny ekran (bardziej niezawodny)
    //    Dodajemy FAB (floating action button) w prawym dolnym rogu.
    const AppRoot = findByName("AppRoot") ?? findByProps("AppRoot");
    if (AppRoot) {
      const key = AppRoot.AppRoot ? "AppRoot" : "default";
      const comp = AppRoot[key] ?? AppRoot;
      if (comp) {
        const p = after(key === "default" ? "default" : "AppRoot", AppRoot, (args, res) => {
          if (!res?.props?.children) return res;
          // Wstaw GlobalSearchRoot jako ostatnie dziecko
          const children = Array.isArray(res.props.children)
            ? [...res.props.children, React.createElement(GlobalSearchRoot, { key: "gs-root" })]
            : [res.props.children, React.createElement(GlobalSearchRoot, { key: "gs-root" })];
          return { ...res, props: { ...res.props, children } };
        });
        patches.push(p);
      }
    }

    // 4) FAB (floating button) — patch na NavigationContainer lub główny Stack
    //    To jest metoda fallback — jeśli powyższe nie działają, zawsze zobaczymy guzik.
    const NavigationContainer = findByProps("NavigationContainer")?.NavigationContainer
      ?? findByName("NavigationContainer");
    if (NavigationContainer) {
      const p = after("render", NavigationContainer.prototype ?? {}, (args, res) => {
        if (!res) return res;
        return React.createElement(
          View,
          { style: { flex: 1 } },
          res,
          React.createElement(GlobalSearchRoot, { key: "gs-root" }),
          // Floating button w prawym dolnym rogu
          React.createElement(
            TouchableOpacity,
            {
              key: "gs-fab",
              onPress: () => modalVisible_state.setter?.(true),
              style: {
                position: "absolute",
                bottom: 90,
                right: 16,
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: DC.accent,
                alignItems: "center",
                justifyContent: "center",
                elevation: 8,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.3,
                shadowRadius: 4,
              },
            },
            React.createElement(Text, { style: { fontSize: 20 } }, "🔍")
          )
        );
      });
      patches.push(p);
    }

    console.log("[GlobalSearch] plugin started, patches:", patches.length);
  }

  function stop() {
    patches.forEach((p) => p?.());
    patches = [];
    console.log("[GlobalSearch] plugin stopped");
  }

  // ─── Eksport dla Revenge/Bunny ────────────────────────────────────────────
  module.exports = { start, stop };
})();
