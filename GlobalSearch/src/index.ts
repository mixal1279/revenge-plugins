import { find, findByProps, findByStoreName } from "@revenge-mod/metro";
import { ReactNative as RN } from "@revenge-mod/metro/common";
import { after } from "@revenge-mod/patcher";
import { showToast } from "@revenge-mod/ui/toasts";
import { getAssetIDByName } from "@revenge-mod/ui/assets";
import { Forms } from "@revenge-mod/ui";
import { storage } from "@revenge-mod/plugin";

declare const React: typeof import("react");

const { FormRow, FormInput, FormText } = Forms;
const {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Image,
  Modal,
  SafeAreaView,
} = RN;

const GuildStore = findByStoreName("GuildStore");
const AuthStore = findByStoreName("AuthenticationStore");

const APIModule = findByProps("getAPIBaseURL");
const getAPIBaseURL =
  APIModule?.getAPIBaseURL || (() => "https://discord.com/api/v9");

const patches: (() => void)[] = [];

export const vstorage = storage as { showInChannelListHeader: boolean };

// Keep Discord API traffic bounded. A request per guild in parallel can
// very quickly trigger rate limits on large accounts.
const MAX_CONCURRENT_REQUESTS = 4;
const REQUEST_RETRIES = 1;

type SearchResult = {
  messages: any[];
  totalResults: number;
};

async function fetchGuildSearch(
  guild: any,
  query: string,
  limit: number,
  offset: number,
): Promise<{ hits: any[]; total: number }> {
  const token = AuthStore?.getToken?.();
  if (!token) return { hits: [], total: 0 };

  const url =
    `${getAPIBaseURL()}/guilds/${guild.id}/messages/search?q=${encodeURIComponent(
      query,
    )}&limit=${limit}&offset=${offset}`;

  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        if (attempt < REQUEST_RETRIES && retryAfter > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(retryAfter * 1000, 5000)),
          );
          continue;
        }
        return { hits: [], total: 0 };
      }

      if (!res.ok) return { hits: [], total: 0 };

      const data = await res.json();
      if (!Array.isArray(data.messages)) return { hits: [], total: 0 };

      const hits = data.messages
        .map((hitGroup: any[]) => {
          const hit = Array.isArray(hitGroup)
            ? hitGroup.find((message) => message?.hit) ?? hitGroup[0]
            : hitGroup;

          if (!hit) return null;

          return {
            ...hit,
            guildName: guild.name,
            guildId: guild.id,
          };
        })
        .filter(Boolean);

      return {
        hits,
        total: Number.isFinite(data.total_results)
          ? Number(data.total_results)
          : 0,
      };
    } catch (error) {
      if (attempt === REQUEST_RETRIES) {
        console.error(`[GlobalSearch] ${guild.name}:`, error);
      }
    }
  }

  return { hits: [], total: 0 };
}

async function performGlobalSearch(
  query: string,
  limit = 25,
  offset = 0,
): Promise<SearchResult> {
  const token = AuthStore?.getToken?.();
  if (!token) {
    showToast(
      "Brak tokenu Discord!",
      getAssetIDByName("CircleXIcon-primary"),
    );
    return { messages: [], totalResults: 0 };
  }

  const guilds = Object.values(GuildStore?.getGuilds?.() ?? {}) as any[];
  const allMessages: any[] = [];
  let totalResults = 0;

  // Small worker pool instead of Promise.all(guilds.map(...)).
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < guilds.length) {
      const index = nextIndex++;
      const guild = guilds[index];
      if (!guild?.id) continue;

      const result = await fetchGuildSearch(guild, query, limit, offset);
      allMessages.push(...result.hits);
      totalResults += result.total;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_REQUESTS, guilds.length) },
      () => worker(),
    ),
  );

  allMessages.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

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
    if (!q.trim() || loading) return;

    setLoading(true);
    setHasSearched(true);

    try {
      const { messages, totalResults } = await performGlobalSearch(
        q.trim(),
        ITEMS_PER_PAGE,
        pageNum * ITEMS_PER_PAGE,
      );

      setResults((prev) =>
        pageNum === 0 ? messages : [...prev, ...messages],
      );
      setTotalAvailableResults(totalResults);
    } catch (error) {
      console.error("[GlobalSearch] Search failed:", error);
      showToast(
        "Wyszukiwanie nie powiodło się.",
        getAssetIDByName("CircleXIcon-primary"),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleInitialSearch = () => {
    if (!query.trim() || loading) return;

    setCurrentPage(0);
    setResults([]);
    setTotalAvailableResults(0);
    void executeSearch(query, 0);
  };

  const handleLoadMore = () => {
    if (loading || !query.trim()) return;

    // Every guild has its own Discord search offset, so the number of
    // returned rows is not a reliable global pagination boundary.
    // Stop only when the requested guild pages no longer produce results.
    const next = currentPage + 1;
    setCurrentPage(next);
    void executeSearch(query, next);
  };

  const canLoadMore =
    !loading &&
    hasSearched &&
    results.length > 0 &&
    currentPage < 100; // defensive upper bound against accidental endless scrolling

  return React.createElement(
    SafeAreaView,
    { style: { flex: 1, backgroundColor: "#36393f" } },
    [
      React.createElement(
        View,
        {
          key: "header",
          style: {
            flexDirection: "row",
            alignItems: "center",
            padding: 12,
            borderBottomWidth: 1,
            borderBottomColor: "#26282c",
          },
        },
        [
          React.createElement(
            Text,
            {
              key: "title",
              style: {
                color: "#fff",
                fontSize: 17,
                fontWeight: "bold",
                flex: 1,
              },
            },
            "🔍 Szukaj we wszystkich serwerach",
          ),
          onClose &&
            React.createElement(
              TouchableOpacity,
              { key: "close", onPress: onClose, style: { padding: 6 } },
              React.createElement(
                Text,
                { style: { color: "#A3A6AA", fontSize: 20 } },
                "✕",
              ),
            ),
        ],
      ),
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
              disabled: loading || !query.trim(),
              style: {
                backgroundColor: "#5865F2",
                padding: 12,
                borderRadius: 6,
                alignItems: "center",
                opacity: loading || !query.trim() ? 0.5 : 1,
              },
            },
            React.createElement(
              Text,
              { style: { color: "#fff", fontWeight: "bold", fontSize: 15 } },
              loading ? "Szukam..." : "Szukaj",
            ),
          ),
        ],
      ),
      loading
        ? React.createElement(ActivityIndicator, {
            key: "spinner",
            size: "large",
            color: "#5865F2",
            style: { marginTop: 30 },
          })
        : null,
      !loading && hasSearched && results.length > 0
        ? React.createElement(
            FormText,
            {
              key: "count",
              style: {
                paddingHorizontal: 12,
                marginBottom: 4,
                color: "#A3A6AA",
                fontSize: 12,
              },
            },
            `Wyniki: ${results.length} • znaleziono łącznie ~${totalAvailableResults}`,
          )
        : null,
      !loading && hasSearched && results.length === 0
        ? React.createElement(
            Text,
            {
              key: "empty",
              style: {
                color: "#dcddde",
                textAlign: "center",
                marginTop: 40,
                fontSize: 15,
              },
            },
            "Brak wyników.",
          )
        : null,
      React.createElement(FlatList, {
        key: "list",
        data: results,
        keyExtractor: (item: any, index: number) =>
          `${item.id}-${item.guildId}-${index}`,
        renderItem: ({ item }: any) =>
          React.createElement(FormRow, {
            label: `[${item.guildName}] ${item.author?.username ?? "Nieznany"}`,
            subLabel: item.content ?? "(brak treści)",
            trailing: React.createElement(
              Text,
              { style: { color: "#72767d", fontSize: 11 } },
              new Date(item.timestamp).toLocaleDateString("pl-PL"),
            ),
            onPress: () =>
              showToast(
                `#${item.channel_id} • ${new Date(
                  item.timestamp,
                ).toLocaleString("pl-PL")}`,
                getAssetIDByName("ChatIcon"),
              ),
          }),
        style: { flex: 1 },
        onEndReached: canLoadMore ? handleLoadMore : undefined,
        onEndReachedThreshold: 0.5,
        ListFooterComponent: loading
          ? React.createElement(ActivityIndicator, {
              size: "small",
              color: "#5865F2",
              style: { margin: 10 },
            })
          : null,
      }),
    ],
  );
};

// ─── Modal wrapper ────────────────────────────────────────────────────────────

const GlobalSearchModal = () => {
  const [visible, setVisible] = React.useState(false);

  (GlobalSearchModal as any)._open = () => setVisible(true);

  return React.createElement(
    Modal,
    {
      visible,
      animationType: "slide",
      onRequestClose: () => setVisible(false),
    },
    React.createElement(GlobalSearchUI, {
      onClose: () => setVisible(false),
    }),
  );
};

// ─── onLoad / onUnload ───────────────────────────────────────────────────────

export function onLoad() {
  showToast(
    "Global Search loaded!",
    getAssetIDByName("SearchIcon"),
  );

  vstorage.showInChannelListHeader ??= true;

  // Classic Revenge exposes ChannelHeader as the `default` export of its Metro module.
  // The patcher patches a method on the exporting object, not the component function itself.
  const ChannelHeaderModule = find((module: any) => module?.default?.name === "ChannelHeader");

  if (ChannelHeaderModule?.default) {
    patches.push(
      after("default", ChannelHeaderModule, (_, res) => {
        if (!vstorage.showInChannelListHeader || !res?.props) return;

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
          }),
        );

        const modal = React.createElement(GlobalSearchModal, {
          key: "global-search-modal",
        });

        const currentChildren = res.props.children;

        if (Array.isArray(currentChildren)) {
          const children = currentChildren.slice();

          // Avoid adding duplicate controls when Discord re-renders the header.
          if (!children.some((child: any) => child?.key === "global-search-btn")) {
            children.push(searchBtn, modal);
            res.props.children = children;
          }
        } else if (
          currentChildren?.props &&
          Array.isArray(currentChildren.props.children)
        ) {
          const nested = currentChildren.props.children.slice();

          if (!nested.some((child: any) => child?.key === "global-search-btn")) {
            nested.push(searchBtn, modal);
            res.props.children = React.cloneElement(currentChildren, {
              children: nested,
            });
          }
        }
      }),
    );
  } else {
    showToast(
      "ChannelHeader nie znaleziony — użyj ustawień pluginu.",
      getAssetIDByName("CircleXIcon-primary"),
    );
  }
}

export function onUnload() {
  patches.splice(0).forEach((unpatch) => unpatch());
  showToast(
    "Global Search unloaded!",
    getAssetIDByName("SearchIcon"),
  );
}

export const settings = GlobalSearchUI;


// Classic Revenge/Bunny native plugin lifecycle.
// The loader expects a plugin instance with start/stop methods.
export default {
  start: onLoad,
  stop: onUnload,
  SettingsComponent: GlobalSearchUI,
};
