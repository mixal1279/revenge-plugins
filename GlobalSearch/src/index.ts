import { findByProps, findByStoreName, findByName } from "@revenge-mod/metro";
import { ReactNative as RN } from "@revenge-mod/metro/common";
import { after } from "@revenge-mod/patcher";
import { showToast } from "@revenge-mod/ui/toasts";
import { getAssetIDByName } from "@revenge-mod/ui/assets";
import { Forms } from "@revenge-mod/ui";
import { storage } from "@revenge-mod/plugin";

declare const React: typeof import("react");

const { FormRow, FormInput, FormText } = Forms;
const { View, Text, TouchableOpacity, FlatList, ActivityIndicator, Image, Modal, SafeAreaView } = RN;

const GuildStore = findByStoreName("GuildStore");
const AuthStore = findByStoreName("AuthenticationStore");

const APIModule = findByProps("getAPIBaseURL");
const getAPIBaseURL = APIModule?.getAPIBaseURL || (() => "https://discord.com/api/v9");

let patches: (() => void)[] = [];

export const vstorage = storage as { showInChannelListHeader: boolean };

// ─── Wyszukiwanie ────────────────────────────────────────────────────────────

async function performGlobalSearch(query: string, limit = 25, offset = 0) {
  const token = AuthStore.getToken();
  if (!token) {
    showToast("Brak tokenu Discord!", getAssetIDByName("CircleXIcon-primary"));
    return { messages: [], totalResults: 0 };
  }

  const guilds = Object.values(GuildStore.getGuilds()) as any[];

  const results = await Promise.all(
    guilds.map(async (guild: any) => {
      try {
        const res = await fetch(
          `${getAPIBaseURL()}/guilds/${guild.id}/messages/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
          { headers: { Authorization: token, "Content-Type": "application/json" } }
        );
        if (!res.ok) return { hits: [], total: 0 };
        const data = await res.json();
        if (!data.messages) return { hits: [], total: 0 };
        const hits = data.messages.map((hitGroup: any[]) => {
          const hit = hitGroup.find((m) => m.hit) || hitGroup[0];
          return { ...hit, guildName: guild.name, guildId: guild.id };
        });
        return { hits, total: data.total_results || 0 };
      } catch (e) {
        console.error(`[GlobalSearch] ${guild.name}:`, e);
        return { hits: [], total: 0 };
      }
    })
  );

  const allMessages: any[] = [];
  let totalResults = 0;
  for (const r of results) {
    allMessages.push(...r.hits);
    totalResults += r.total;
  }
  allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return { messages: allMessages, totalResults };
}

// ─── UI komponent ────────────────────────────────────────────────────────────

const GlobalSearchUI = ({ onClose }: { onClose?: () => void }) => {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [hasSearched, setHasSearched] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [totalAvailableResults, setTotalAvailableResults] = React.useState(0);

  const ITEMS_PER_PAGE = 25;

  const executeSearch = async (q: string, pageNum: number) => {
    if (!q.trim()) return;
    setLoading(true);
    setHasSearched(true);
    const { messages, totalResults } = await performGlobalSearch(q, ITEMS_PER_PAGE, pageNum * ITEMS_PER_PAGE);
    setResults((prev) => (pageNum === 0 ? messages : [...prev, ...messages]));
    setTotalAvailableResults(totalResults);
    setLoading(false);
  };

  const handleInitialSearch = () => {
    setCurrentPage(0);
    setResults([]);
    executeSearch(query, 0);
  };

  const handleLoadMore = () => {
    if (!loading && results.length < totalAvailableResults) {
      const next = currentPage + 1;
      setCurrentPage(next);
      executeSearch(query, next);
    }
  };

  return React.createElement(
    SafeAreaView,
    { style: { flex: 1, backgroundColor: "#36393f" } },
    [
      // Nagłówek z przyciskiem zamknięcia
      React.createElement(
        View,
        { key: "header", style: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: "#26282c" } },
        [
          React.createElement(Text, { key: "title", style: { color: "#fff", fontSize: 17, fontWeight: "bold", flex: 1 } }, "🔍 Szukaj we wszystkich serwerach"),
          onClose && React.createElement(
            TouchableOpacity,
            { key: "close", onPress: onClose, style: { padding: 6 } },
            React.createElement(Text, { style: { color: "#A3A6AA", fontSize: 20 } }, "✕")
          ),
        ]
      ),

      // Input + przycisk
      React.createElement(
        View,
        { key: "search-bar", style: { padding: 12 } },
        [
          React.createElement(FormInput, {
            key: "input",
            title: "Fraza",
            value: query,
            onChange: setQuery,
            placeholder: "Wpisz tekst...",
            onSubmitEditing: handleInitialSearch,
            returnKeyType: "search",
            style: { marginBottom: 8 },
          }),
          React.createElement(
            TouchableOpacity,
            {
              key: "btn",
              onPress: handleInitialSearch,
              style: { backgroundColor: "#5865F2", padding: 12, borderRadius: 6, alignItems: "center" },
            },
            React.createElement(Text, { style: { color: "#fff", fontWeight: "bold", fontSize: 15 } }, "Szukaj")
          ),
        ]
      ),

      // Spinner / info / lista
      loading
        ? React.createElement(ActivityIndicator, { key: "spinner", size: "large", color: "#5865F2", style: { marginTop: 30 } })
        : null,

      !loading && hasSearched && results.length > 0
        ? React.createElement(
            FormText,
            { key: "count", style: { paddingHorizontal: 12, marginBottom: 4, color: "#A3A6AA", fontSize: 12 } },
            `Wyniki: ${results.length} z ~${totalAvailableResults}`
          )
        : null,

      !loading && hasSearched && results.length === 0
        ? React.createElement(
            Text,
            { key: "empty", style: { color: "#dcddde", textAlign: "center", marginTop: 40, fontSize: 15 } },
            "Brak wyników."
          )
        : null,

      React.createElement(FlatList, {
        key: "list",
        data: results,
        keyExtractor: (item: any) => `${item.id}-${item.guildId}`,
        renderItem: ({ item }: any) =>
          React.createElement(FormRow, {
            label: `[${item.guildName}] ${item.author?.username ?? "Nieznany"}`,
            subLabel: item.content ?? "(brak treści)",
            trailing: React.createElement(
              Text,
              { style: { color: "#72767d", fontSize: 11 } },
              new Date(item.timestamp).toLocaleDateString("pl-PL")
            ),
            onPress: () =>
              showToast(
                `#${item.channel_id} • ${new Date(item.timestamp).toLocaleString("pl-PL")}`,
                getAssetIDByName("ChatIcon")
              ),
          }),
        style: { flex: 1 },
        onEndReached: handleLoadMore,
        onEndReachedThreshold: 0.5,
        ListFooterComponent: loading
          ? React.createElement(ActivityIndicator, { size: "small", color: "#5865F2", style: { margin: 10 } })
          : null,
      }),
    ]
  );
};

// ─── Modal wrapper ────────────────────────────────────────────────────────────

// Komponent który trzyma stan widoczności modala i renderuje go
const GlobalSearchModal = () => {
  const [visible, setVisible] = React.useState(false);

  // Eksponujemy funkcję otwierającą globalnie, żeby przycisk w headerze mógł ją wywołać
  (GlobalSearchModal as any)._open = () => setVisible(true);

  return React.createElement(
    Modal,
    {
      visible,
      animationType: "slide",
      onRequestClose: () => setVisible(false),
    },
    React.createElement(GlobalSearchUI, { onClose: () => setVisible(false) })
  );
};

// ─── onLoad / onUnload ───────────────────────────────────────────────────────

export function onLoad() {
  showToast("Global Search loaded!", getAssetIDByName("SearchIcon"));
  vstorage.showInChannelListHeader ??= true;

  const ChannelListHeader = findByName("ChannelListHeader");

  if (ChannelListHeader) {
    patches.push(
      after("default", ChannelListHeader, (_, res) => {
        if (!vstorage.showInChannelListHeader) return;

        const searchBtn = React.createElement(
          TouchableOpacity,
          {
            key: "global-search-btn",
            onPress: () => (GlobalSearchModal as any)._open?.(),
            style: { marginRight: 10, padding: 4 },
          },
          React.createElement(Image, {
            source: getAssetIDByName("SearchIcon"),
            style: { width: 22, height: 22, tintColor: "#FFFFFF" },
          })
        );

        const children = res?.props?.children;
        if (Array.isArray(children)) {
          children.push(searchBtn);
        } else if (children?.props?.children && Array.isArray(children.props.children)) {
          children.props.children.push(searchBtn);
        }
      })
    );
  } else {
    showToast("ChannelListHeader nie znaleziony — użyj ustawień pluginu.", getAssetIDByName("CircleXIcon-primary"));
  }
}

export function onUnload() {
  patches.forEach((p) => p());
  patches = [];
  showToast("Global Search unloaded!", getAssetIDByName("SearchIcon"));
}

// Settings page też działa jako fallback jeśli header patch nie zadziała
export const settings = GlobalSearchUI;
