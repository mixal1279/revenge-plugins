import { find, findByNameAll, findByProps, findByStoreName } from "@revenge-mod/metro";
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

// Optional navigation modules. Search results remain usable even if a
// particular Discord build does not expose one of these actions.
function getMessageActions() {
  try {
    return findByProps("jumpToMessage");
  } catch {
    return undefined;
  }
}

function getChannelActions() {
  try {
    return findByProps("selectChannel");
  } catch {
    return undefined;
  }
}

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
  signal?: AbortSignal,
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
        signal,
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
  signal?: AbortSignal,
): Promise<SearchResult & { hasMore: boolean }> {
  const token = AuthStore?.getToken?.();
  if (!token) {
    showToast(
      "Brak tokenu Discord!",
      getAssetIDByName("CircleXIcon-primary"),
    );
    return { messages: [], totalResults: 0, hasMore: false };
  }

  const guilds = Object.values(GuildStore?.getGuilds?.() ?? {}) as any[];
  const allMessages: any[] = [];
  let totalResults = 0;
  let hasMore = false;

  // Small worker pool instead of Promise.all(guilds.map(...)).
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < guilds.length) {
      const index = nextIndex++;
      const guild = guilds[index];
      if (!guild?.id) continue;

      const result = await fetchGuildSearch(guild, query, limit, offset, signal);
      allMessages.push(...result.hits);
      totalResults += result.total;

      // Discord paginates independently per guild. Keep loading while at
      // least one guild reports another page, or returned a full page when
      // total_results is unavailable.
      if (
        result.hits.length >= limit ||
        (result.total > 0 && offset + result.hits.length < result.total)
      ) {
        hasMore = true;
      }
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

  return { messages: allMessages, totalResults, hasMore };
}

async function openSearchResult(item: any) {
  const channelId = item?.channel_id;
  const messageId = item?.id;

  if (!channelId || !messageId) {
    showToast(
      "Nie można otworzyć tego wyniku.",
      getAssetIDByName("CircleXIcon-primary"),
    );
    return;
  }

  const jump = getMessageActions()?.jumpToMessage;
  if (typeof jump === "function") {
    try {
      await Promise.resolve(
        jump({
          channelId,
          messageId,
          flash: true,
          jumpType: "INSTANT",
        }),
      );
      return;
    } catch {
      try {
        await Promise.resolve(jump(channelId, messageId, true));
        return;
      } catch {
        // Fall through to channel selection.
      }
    }
  }

  const selectChannel = getChannelActions()?.selectChannel;
  if (typeof selectChannel === "function") {
    try {
      selectChannel(channelId);
      showToast(
        "Otwarto kanał. Przejdź do znalezionej wiadomości.",
        getAssetIDByName("ChatIcon"),
      );
      return;
    } catch {
      // Fall through to an informational toast.
    }
  }

  showToast(
    `Kanał: ${channelId} • wiadomość: ${messageId}`,
    getAssetIDByName("ChatIcon"),
  );
}

// ─── UI komponent ────────────────────────────────────────────────────────────

const GlobalSearchUI = ({ onClose }: { onClose?: () => void }) => {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [hasSearched, setHasSearched] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [totalAvailableResults, setTotalAvailableResults] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const searchGeneration = React.useRef(0);
  const ITEMS_PER_PAGE = 25;

  const executeSearch = async (q: string, pageNum: number) => {
    if (!q.trim() || loading) return;

    const generation = ++searchGeneration.current;
    setLoading(true);
    setHasSearched(true);

    try {
      const { messages, totalResults, hasMore: nextHasMore } =
        await performGlobalSearch(
          q.trim(),
          ITEMS_PER_PAGE,
          pageNum * ITEMS_PER_PAGE,
        );

      if (generation !== searchGeneration.current) return;

      setResults((prev) =>
        pageNum === 0 ? messages : [...prev, ...messages],
      );
      setTotalAvailableResults(totalResults);
      setHasMore(nextHasMore);
    } catch (error) {
      console.error("[GlobalSearch] Search failed:", error);
      showToast(
        "Wyszukiwanie nie powiodło się.",
        getAssetIDByName("CircleXIcon-primary"),
      );
    } finally {
      if (generation === searchGeneration.current) {
        setLoading(false);
      }
    }
  };

  const handleInitialSearch = () => {
    if (!query.trim() || loading) return;

    setCurrentPage(0);
    setResults([]);
    setTotalAvailableResults(0);
    setHasMore(false);
    ++searchGeneration.current;
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
    hasMore &&
    results.length > 0 &&
    currentPage < 100;

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
            onPress: () => {
              void openSearchResult(item);
            },
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

// Reuses Discord's existing search icon and adds a second search mode.
const SearchModePicker = () => {
  const [visible, setVisible] = React.useState(false);
  const nativeSearchRef = React.useRef<(() => void) | null>(null);

  (SearchModePicker as any)._open = (nativeSearch: () => void) => {
    nativeSearchRef.current = nativeSearch;
    setVisible(true);
  };

  const close = () => setVisible(false);

  return React.createElement(
    Modal,
    {
      visible,
      transparent: true,
      animationType: "fade",
      onRequestClose: close,
    },
    React.createElement(
      View,
      {
        style: {
          flex: 1,
          justifyContent: "center",
          padding: 24,
          backgroundColor: "rgba(0,0,0,0.65)",
        },
      },
      React.createElement(
        View,
        {
          style: {
            backgroundColor: "#2b2d31",
            borderRadius: 12,
            padding: 16,
          },
        },
        [
          React.createElement(
            Text,
            {
              key: "title",
              style: {
                color: "#fff",
                fontSize: 18,
                fontWeight: "bold",
                marginBottom: 12,
              },
            },
            "Wyszukiwanie",
          ),
          React.createElement(
            TouchableOpacity,
            {
              key: "native",
              onPress: () => {
                const callback = nativeSearchRef.current;
                close();
                callback?.();
              },
              style: {
                padding: 14,
                borderRadius: 8,
                backgroundColor: "#36393f",
                marginBottom: 8,
              },
            },
            React.createElement(
              Text,
              { style: { color: "#fff", fontSize: 15 } },
              "🔍 Szukaj na tym kanale",
            ),
          ),
          React.createElement(
            TouchableOpacity,
            {
              key: "global",
              onPress: () => {
                close();
                (GlobalSearchModal as any)._open?.();
              },
              style: {
                padding: 14,
                borderRadius: 8,
                backgroundColor: "#5865F2",
                marginBottom: 8,
              },
            },
            React.createElement(
              Text,
              { style: { color: "#fff", fontSize: 15 } },
              "🌐 Szukaj we wszystkich serwerach",
            ),
          ),
          React.createElement(
            TouchableOpacity,
            {
              key: "cancel",
              onPress: close,
              style: { padding: 10, alignItems: "center" },
            },
            React.createElement(
              Text,
              { style: { color: "#b5bac1", fontSize: 14 } },
              "Anuluj",
            ),
          ),
        ],
      ),
    ),
  );
};

// ─── onLoad / onUnload ───────────────────────────────────────────────────────

const HEADER_COMPONENT_NAMES = [
  "ChannelHeader",
  "Header",
  "FriendsHeader",
  "PrivateChannelsHeader",
  "DirectMessageHeader",
  "DMListHeader",
  "HomeHeader",
  "ChannelListHeader",
];

function getHeaderModules(): { module: any; exportName: string }[] {
  const modules: { module: any; exportName: string }[] = [];
  const seen = new Set<any>();

  const addComponent = (component: any) => {
    if (!component) return;

    // Classic Revenge's findByNameAll() returns the component function
    // itself on this Discord build, not necessarily its webpack export
    // object. Resolve that function back to the module that exports it.
    let module: any = component;
    let exportName = "default";

    if (typeof component === "function") {
      try {
        const resolved = find((candidate: any) => {
          try {
            return Object.values(candidate || {}).some(
              (value) => value === component,
            );
          } catch {
            return false;
          }
        });

        if (!resolved) return;

        const entry = Object.entries(resolved).find(
          ([, value]) => value === component,
        );
        if (!entry) return;

        module = resolved;
        exportName = entry[0];
      } catch {
        return;
      }
    } else if (typeof component === "object") {
      const entry = Object.entries(component).find(
        ([, value]) => typeof value === "function",
      );
      if (!entry) return;
      exportName = entry[0];
    }

    if (!module || typeof module !== "object") return;
    if (typeof module[exportName] !== "function") return;
    if (seen.has(module)) return;

    seen.add(module);
    modules.push({ module, exportName });
  };

  for (const name of HEADER_COMPONENT_NAMES) {
    let found: any[] = [];
    try {
      found = findByNameAll(name) ?? [];
    } catch {
      found = [];
    }

    for (const component of found) {
      addComponent(component);
    }
  }

  return modules;
}

function containsGlobalSearchPicker(children: any) {
  const list = Array.isArray(children)
    ? children
    : children != null
      ? [children]
      : [];

  return list.some(
    (child: any) => child?.key === "global-search-mode-picker",
  );
}

function patchSearchButton(
  node: any,
  searchIconId: any,
): { node: any; found: boolean; changed: boolean } {
  if (!React.isValidElement(node)) {
    return { node, found: false, changed: false };
  }

  const children = node.props?.children;
  const list = Array.isArray(children)
    ? children
    : children != null
      ? [children]
      : [];

  let changed = false;
  let found = false;

  const nextChildren = list.map((child: any) => {
    if (!React.isValidElement(child)) return child;

    const childChildren = child.props?.children;
    const candidates = Array.isArray(childChildren)
      ? childChildren
      : childChildren != null
        ? [childChildren]
        : [];

    const isNativeSearchButton =
      typeof child.props?.onPress === "function" &&
      candidates.some(
        (candidate: any) =>
          React.isValidElement(candidate) &&
          candidate.props?.source === searchIconId,
      );

    if (isNativeSearchButton) {
      found = true;

      if (child.props?.onPress?.__globalSearchPatched) {
        return child;
      }

      changed = true;

      const wrappedOnPress = () => {
        (SearchModePicker as any)._open?.(child.props.onPress);
      };
      (wrappedOnPress as any).__globalSearchPatched = true;

      return React.cloneElement(child, {
        onPress: wrappedOnPress,
      });
    }

    const nested = patchSearchButton(child, searchIconId);
    if (nested.found) found = true;
    if (nested.changed) changed = true;
    return nested.node;
  });

  if (!changed) return { node, found, changed: false };

  return {
    node: React.cloneElement(node, {
      children: Array.isArray(children)
        ? nextChildren
        : nextChildren[0] ?? null,
    }),
    found,
    changed: true,
  };
}

export function onLoad() {
  showToast(
    "Global Search loaded!",
    getAssetIDByName("SearchIcon"),
  );

  vstorage.showInChannelListHeader ??= true;

  const searchIconId = getAssetIDByName("SearchIcon");
  const patchedModules = new Set<any>();

  for (const { module, exportName } of getHeaderModules()) {
    if (!module || patchedModules.has(module)) continue;
    patchedModules.add(module);

    patches.push(
      after(exportName, module, (_, res) => {
        if (!React.isValidElement(res)) return res;
        if (!vstorage.showInChannelListHeader) return res;

        const result = patchSearchButton(res, searchIconId);
        if (!result.found) return res;

        const children = result.node.props?.children;
        if (!Array.isArray(children)) return result.node;

        if (containsGlobalSearchPicker(children)) {
          return result.node;
        }

        return React.cloneElement(result.node, {
          children: [
            ...children,
            React.createElement(SearchModePicker, {
              key: "global-search-mode-picker",
            }),
          ],
        });
      }),
    );
  }

  if (patches.length === 0) {
    showToast(
      "Nie znaleziono obsługiwanych nagłówków.",
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
export default {
  start: onLoad,
  stop: onUnload,
  SettingsComponent: GlobalSearchUI,
};
