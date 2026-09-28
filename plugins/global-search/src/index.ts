import { getJsonStorage, pluginStoragePathFor } from "@revenge-mod/json-storage";
import { getAssetIdByName } from "@revenge-mod/assets";
import { after } from "@revenge-mod/patcher";
import { withName, withProps } from "@revenge-mod/modules/finders/filters";
import { lookupModule } from "@revenge-mod/modules/finders";
import { React, ReactNative } from "@revenge-mod/react";

type SearchResult = {
  messages: any[];
  totalResults: number;
};

type Settings = {
  showInChannelListHeader: boolean;
};

const storage = getJsonStorage<Settings>(
  pluginStoragePathFor("global-search", "settings.json"),
  { default: { showInChannelListHeader: true }, load: true },
);

const MAX_CONCURRENT_REQUESTS = 4;
const REQUEST_RETRIES = 1;
const ITEMS_PER_PAGE = 25;

let unpatches: (() => void)[] = [];
let openSearch: (() => void) | undefined;

const getGuildStore = () =>
  lookupModule(withProps("getGuilds"))[0] as
    | { getGuilds?: () => Record<string, any> }
    | undefined;

const getAuthStore = () =>
  lookupModule(withProps("getToken"))[0] as
    | { getToken?: () => string }
    | undefined;

const getApiModule = () =>
  lookupModule(withProps("getAPIBaseURL"))[0] as
    | { getAPIBaseURL?: () => string }
    | undefined;

async function fetchGuildSearch(
  guild: any,
  query: string,
  limit: number,
  offset: number,
): Promise<{ hits: any[]; total: number }> {
  const token = getAuthStore()?.getToken?.();
  if (!token || !guild?.id) return { hits: [], total: 0 };

  const baseUrl =
    getApiModule()?.getAPIBaseURL?.() ?? "https://discord.com/api/v9";

  const url =
    `${baseUrl}/guilds/${guild.id}/messages/search?q=${encodeURIComponent(
      query,
    )}&limit=${limit}&offset=${offset}`;

  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "0");
        if (attempt < REQUEST_RETRIES && retryAfter > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(retryAfter * 1000, 5000)),
          );
          continue;
        }
        return { hits: [], total: 0 };
      }

      if (!response.ok) return { hits: [], total: 0 };

      const data = await response.json();
      if (!Array.isArray(data.messages)) return { hits: [], total: 0 };

      const hits = data.messages
        .map((group: any) => {
          const hit = Array.isArray(group)
            ? group.find((message: any) => message?.hit) ?? group[0]
            : group;

          return hit
            ? {
                ...hit,
                guildName: guild.name ?? "Nieznany serwer",
                guildId: guild.id,
              }
            : null;
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
        console.error("[GlobalSearch] Guild search failed:", error);
      }
    }
  }

  return { hits: [], total: 0 };
}

async function performGlobalSearch(
  query: string,
  limit = ITEMS_PER_PAGE,
  offset = 0,
): Promise<SearchResult> {
  const token = getAuthStore()?.getToken?.();
  if (!token) throw new Error("Discord token unavailable");

  const guilds = Object.values(getGuildStore()?.getGuilds?.() ?? {});
  const messages: any[] = [];
  let totalResults = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < guilds.length) {
      const guild = guilds[nextIndex++];
      if (!guild?.id) continue;

      const result = await fetchGuildSearch(guild, query, limit, offset);
      messages.push(...result.hits);
      totalResults += result.total;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_REQUESTS, guilds.length) },
      () => worker(),
    ),
  );

  messages.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return { messages, totalResults };
}

function SearchScreen({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const [total, setTotal] = React.useState(0);

  const search = async (pageNumber: number) => {
    if (!query.trim() || loading) return;

    setLoading(true);
    setSearched(true);

    try {
      const result = await performGlobalSearch(
        query.trim(),
        ITEMS_PER_PAGE,
        pageNumber * ITEMS_PER_PAGE,
      );

      setResults((previous) =>
        pageNumber === 0 ? result.messages : [...previous, ...result.messages],
      );
      setTotal(result.totalResults);
    } catch (error) {
      console.error("[GlobalSearch] Search failed:", error);
    } finally {
      setLoading(false);
    }
  };

  const runInitialSearch = () => {
    if (!query.trim() || loading) return;
    setPage(0);
    setResults([]);
    setTotal(0);
    void search(0);
  };

  const loadMore = () => {
    if (loading || !query.trim()) return;
    const nextPage = page + 1;
    setPage(nextPage);
    void search(nextPage);
  };

  const canLoadMore = !loading && searched && results.length > 0 && page < 100;

  return React.createElement(
    ReactNative.SafeAreaView,
    { style: { flex: 1, backgroundColor: "#36393f" } },
    [
      React.createElement(
        ReactNative.View,
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
            ReactNative.Text,
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
          React.createElement(
            ReactNative.TouchableOpacity,
            {
              key: "close",
              onPress: onClose,
              style: { padding: 6 },
            },
            React.createElement(
              ReactNative.Text,
              { style: { color: "#A3A6AA", fontSize: 20 } },
              "✕",
            ),
          ),
        ],
      ),
      React.createElement(
        ReactNative.View,
        { key: "input", style: { padding: 12 } },
        [
          React.createElement(ReactNative.TextInput, {
            key: "text-input",
            value: query,
            onChangeText: setQuery,
            placeholder: "Wpisz tekst...",
            placeholderTextColor: "#72767d",
            onSubmitEditing: runInitialSearch,
            returnKeyType: "search",
            style: {
              color: "#fff",
              backgroundColor: "#202225",
              borderRadius: 6,
              padding: 12,
              marginBottom: 8,
            },
          }),
          React.createElement(
            ReactNative.TouchableOpacity,
            {
              key: "search",
              onPress: runInitialSearch,
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
              ReactNative.Text,
              { style: { color: "#fff", fontWeight: "bold", fontSize: 15 } },
              loading ? "Szukam..." : "Szukaj",
            ),
          ),
        ],
      ),
      loading
        ? React.createElement(ReactNative.ActivityIndicator, {
            key: "spinner",
            size: "large",
            style: { marginTop: 20 },
          })
        : null,
      !loading && searched
        ? React.createElement(
            ReactNative.Text,
            {
              key: "count",
              style: {
                color: "#A3A6AA",
                paddingHorizontal: 12,
                marginBottom: 4,
                fontSize: 12,
              },
            },
            results.length
              ? `Wyniki: ${results.length} • znaleziono łącznie ~${total}`
              : "Brak wyników.",
          )
        : null,
      React.createElement(ReactNative.FlatList, {
        key: "list",
        data: results,
        keyExtractor: (item: any, index: number) =>
          `${item.id ?? "unknown"}-${item.guildId ?? "unknown"}-${index}`,
        renderItem: ({ item }: any) =>
          React.createElement(
            ReactNative.TouchableOpacity,
            {
              onPress: () =>
                console.log(
                  `[GlobalSearch] ${item.guildName} #${item.channel_id ?? "?"}`,
                ),
              style: {
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#2f3136",
              },
            },
            [
              React.createElement(
                ReactNative.Text,
                {
                  key: "author",
                  style: { color: "#fff", fontWeight: "600" },
                },
                `[${item.guildName}] ${item.author?.username ?? "Nieznany"}`,
              ),
              React.createElement(
                ReactNative.Text,
                {
                  key: "content",
                  numberOfLines: 3,
                  style: { color: "#dcddde", marginTop: 3 },
                },
                item.content ?? "(brak treści)",
              ),
            ],
          ),
        style: { flex: 1 },
        onEndReached: canLoadMore ? loadMore : undefined,
        onEndReachedThreshold: 0.5,
        ListFooterComponent: loading
          ? React.createElement(ReactNative.ActivityIndicator, {
              size: "small",
              style: { margin: 10 },
            })
          : null,
      }),
    ],
  );
}

function SearchModal() {
  const [visible, setVisible] = React.useState(false);
  openSearch = () => setVisible(true);

  return React.createElement(
    ReactNative.Modal,
    {
      visible,
      animationType: "slide",
      onRequestClose: () => setVisible(false),
    },
    React.createElement(SearchScreen, {
      onClose: () => setVisible(false),
    }),
  );
}

function SettingsComponent() {
  const [settings, setSettings] = React.useState<Settings>({
    showInChannelListHeader: true,
  });

  React.useEffect(() => {
    void storage.get().then(setSettings);
  }, []);

  const update = async (value: boolean) => {
    const next = { showInChannelListHeader: value };
    setSettings(next);
    await storage.set(next);
  };

  return React.createElement(
    ReactNative.View,
    { style: { padding: 16 } },
    [
      React.createElement(
        ReactNative.Text,
        {
          key: "title",
          style: { color: "#fff", fontSize: 17, fontWeight: "700", marginBottom: 8 },
        },
        "Global Search",
      ),
      React.createElement(
        ReactNative.View,
        {
          key: "row",
          style: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 12,
          },
        },
        [
          React.createElement(
            ReactNative.Text,
            { key: "label", style: { color: "#dcddde", flex: 1 } },
            "Pokaż przycisk wyszukiwania w nagłówku kanałów",
          ),
          React.createElement(ReactNative.Switch, {
            key: "switch",
            value: settings.showInChannelListHeader,
            onValueChange: update,
          }),
        ],
      ),
    ],
  );
}

export default plugin({
  SettingsComponent,

  async start(api) {
    const settings = storage.cache ?? (await storage.get());

    if (!settings.showInChannelListHeader) return;

    const header = lookupModule(withName("ChannelListHeader"))[0] as
      | { default: (...args: any[]) => any }
      | undefined;

    if (!header?.default) {
      console.warn("[GlobalSearch] ChannelListHeader not found");
      return;
    }

    unpatches.push(
      after(header, "default", (result: any) => {
        if (!result?.props) return result;

        const searchButton = React.createElement(
          ReactNative.TouchableOpacity,
          {
            key: "global-search-btn",
            onPress: () => openSearch?.(),
            style: { marginRight: 10, padding: 4 },
          },
          React.createElement(
            ReactNative.Text,
            { style: { color: "#fff", fontSize: 22 } },
            "⌕",
          ),
        );

        const modal = React.createElement(SearchModal, {
          key: "global-search-modal",
        });

        const children = result.props.children;

        if (Array.isArray(children)) {
          if (children.some((child: any) => child?.key === "global-search-btn")) {
            return result;
          }

          result.props.children = [...children, searchButton, modal];
          return result;
        }

        if (children?.props && Array.isArray(children.props.children)) {
          if (
            children.props.children.some(
              (child: any) => child?.key === "global-search-btn",
            )
          ) {
            return result;
          }

          result.props.children = React.cloneElement(children, {
            children: [...children.props.children, searchButton, modal],
          });
        }

        return result;
      }),
    );
  },

  stop() {
    unpatches.splice(0).forEach((unpatch) => unpatch());
    openSearch = undefined;
  },
});
