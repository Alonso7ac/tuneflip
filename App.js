// V1.8 — no-reset Back/Close, artwork prefetch, Buy below, 30-day cooldown

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  SafeAreaView, View, Text, FlatList, Image, StyleSheet, Dimensions,
  TouchableOpacity, Pressable, Modal, TextInput, Share, Alert,
  ActivityIndicator, Platform, Animated, PanResponder, BackHandler,
  ScrollView, KeyboardAvoidingView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as Linking from "expo-linking";
import * as Haptics from "expo-haptics";
import { Asset } from "expo-asset";
import { Ionicons } from "@expo/vector-icons";

// ===== Tunables =====
const BACKEND = "https://tuneflip-spotify-proxy.vercel.app";
const PAGE = 20;
const GENRE_FALLBACK = 21; // Rock
const ARTIST_COOLDOWN = 3;
const PER_ARTIST_CAP = 2;

// Share / Deep-link config
const TUNEFLIP_UNIVERSAL_BASE = "https://tuneflip.app/track"; // placeholder
const TUNEFLIP_APPSTORE_URL   = "https://apps.apple.com/app/id0000000000"; // placeholder

// Discovery hygiene
const LIKE_COOLDOWN_DAYS = 30;
const KARAOKE_PATTERNS = [
  /karaoke/i,
  /instrumental(?: version)?/i,
  /tribute/i,
  /backing track/i,
  /as made famous by/i,
  /originally performed/i
];

// ===== Helpers =====
const screen = Dimensions.get("window");
const CARD_HEIGHT = screen.height;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeSeed = () => (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;

const DEFAULT_GENRES = [
  { id: 14, name: "Pop" },
  { id: 18, name: "Hip-Hop/Rap" },
  { id: 21, name: "Rock" },
  { id: 20, name: "Alternative" },
  { id: 6,  name: "Country" },
  { id: 15, name: "R&B/Soul" },
  { id: 17, name: "Dance" },
  { id: 7,  name: "Electronic" },
  { id: 24, name: "Latin" },
  { id: 11, name: "Jazz" },
  { id: 2,  name: "Blues" },
  { id: 5,  name: "Classical" },
];

const OMIT_GENRE_IDS = new Set([16, 1310, 1259]);

const trackKey = (t) => (t?.id || `${t?.title}|${t?.artist}|${t?.album}`);
function rng(seed) { let t = seed % 2147483647; if (t <= 0) t += 2147483646; return () => (t = (t * 48271) % 2147483647) / 2147483647; }
function shuffleInPlace(arr, seed) { const rand = rng(seed); for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

function upscaleArtwork(url) {
  if (!url || typeof url !== "string") return url || "";
  const replacedApple = url.replace(/\/(\d{2,4})x\1([a-z]*\.(?:jpg|jpeg|png))/i, "/600x600$2");
  if (replacedApple !== url) return replacedApple;
  return url.replace(/(\d{2,4})x\1/i, "600x600");
}

function normalizeTrack(t) {
  const title = t.title ?? t.trackName ?? t.name ?? "Unknown title";
  const artist = t.artist ?? t.artistName ?? "Unknown artist";
  const album = t.album ?? t.collectionName ?? "Unknown album";
  const artworkCandidate = t.artworkUrl100 || t.albumArtUrl || t.artwork || "";
  return {
    id: t.trackId ?? t.id ?? `${artist}-${title}-${album}`,
    title, artist, album,
    artwork: upscaleArtwork(artworkCandidate),
    previewUrl: t.previewUrl || "",
    storeUrl: t.storeUrl || t.trackViewUrl || t.collectionViewUrl || t.url || "",
    genreName: t.primaryGenreName || t.genre || t.primaryGenre || t.genreName || ""
  };
}

function diversify(tracks) {
  const out = [], recent = [], counts = {};
  for (const t of tracks) {
    const a = (t.artist || "").trim();
    if ((counts[a] || 0) >= PER_ARTIST_CAP) continue;
    if (recent.slice(-ARTIST_COOLDOWN).includes(a)) continue;
    out.push(t); counts[a] = (counts[a] || 0) + 1; recent.push(a);
  }
  return out;
}

async function fetchGenres() {
  const url = `${BACKEND}/api/itunes-genres?t=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arr = (Array.isArray(data) ? data : []).filter(g => !OMIT_GENRE_IDS.has(Number(g?.id)));
    return arr.length ? arr : DEFAULT_GENRES;
  } catch {
    return DEFAULT_GENRES;
  }
}

async function fetchTracks(genreId, seed) {
  const useSeed = seed ?? makeSeed();
  const url = `${BACKEND}/api/itunes-search?genreId=${genreId}&limit=${PAGE * 3}&seed=${useSeed}&t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
    ? data
    : [];
  const cleaned = diversify(list.map(normalizeTrack).filter((t) => t.title && t.artist));
  return shuffleInPlace(cleaned, useSeed);
}

async function fetchTracksForGenres(genreIds, seed) {
  const ids = (genreIds || []).filter(Boolean);
  if (ids.length === 0) return fetchTracks(GENRE_FALLBACK, seed);

  const perSeed = seed ?? makeSeed();

  const buckets = await Promise.all(
    ids.map(async (id, i) => {
      try {
        const arr = await fetchTracks(id, (perSeed ^ Number(id) ^ (i * 2654435761)) >>> 0);
        return arr;
      } catch { return []; }
    })
  );

  const nonEmpty = buckets.filter((b) => b && b.length);
  if (!nonEmpty.length) return fetchTracks(GENRE_FALLBACK, seed);

  const maxLen = Math.max(...nonEmpty.map((arr) => arr.length));
  const mixed = [];
  for (let i = 0; i < maxLen; i++) for (let g = 0; g < nonEmpty.length; g++) {
    const item = nonEmpty[g][i];
    if (item) mixed.push(item);
  }

  shuffleInPlace(mixed, perSeed ^ 0x9e3779b1);
  const seen = new Set(); const out = [];
  for (const t of mixed) { const k = trackKey(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

// --- Search ---
async function fetchSearchTracks(term, seed) {
  const useSeed = seed ?? makeSeed();
  const enc = encodeURIComponent;
  const base = `limit=${PAGE * 4}&seed=${useSeed}&country=US&t=${Date.now()}`;

  const tries = [
    `${BACKEND}/api/itunes-search?term=${enc(term)}&media=music&entity=musicTrack&${base}`,
    `${BACKEND}/api/itunes-search?term=${enc(term)}&${base}`,
    `${BACKEND}/api/itunes-search?term=${enc(term)}&entity=musicTrack&attribute=songTerm&${base}`,
    `${BACKEND}/api/itunes-search?term=${enc(term)}&entity=musicTrack&attribute=artistTerm&${base}`,
    `${BACKEND}/api/itunes-search?term=${enc(term)}&entity=musicTrack&attribute=albumTerm&${base}`,
  ];

  const pull = async (u) => {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) return [];
      const j = await r.json();
      if (Array.isArray(j?.results)) return j.results;
      if (Array.isArray(j?.items)) return j.items;
      if (Array.isArray(j)) return j;
      return [];
    } catch { return []; }
  };

  let merged = [];
  for (const u of tries) {
    const chunk = await pull(u);
    if (chunk?.length) merged = merged.concat(chunk);
  }

  const normalized = (merged || []).map(normalizeTrack).filter((t) => t.title && t.artist);
  const seen = new Set();
  const deduped = [];
  for (const t of normalized) {
    const k = trackKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(t);
  }
  return shuffleInPlace(diversify(deduped), useSeed);
}

function openInService(track, service) {
  if (!track) return;
  const q = encodeURIComponent(`${track.title} ${track.artist}`);
  if (service === "itunes")  return Linking.openURL(track.storeUrl || `https://music.apple.com/search?term=${q}`);
  if (service === "spotify") return Linking.openURL(`https://open.spotify.com/search/${q}`);
  if (service === "ytmusic") return Linking.openURL(`https://music.youtube.com/search?q=${q}`);
}
function openStore(track) { if (track?.storeUrl) Linking.openURL(track.storeUrl); }

function buildTuneFlipLink(track) {
  const params = new URLSearchParams({
    id: String(track.id || ""),
    title: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    artwork: encodeURIComponent(track.artwork || ""),
    previewUrl: encodeURIComponent(track.previewUrl || ""),
    storeUrl: encodeURIComponent(track.storeUrl || "")
  });
  return `${TUNEFLIP_UNIVERSAL_BASE}?${params.toString()}`;
}
async function shareTrack(track) {
  if (!track) return;
  const tfLink = buildTuneFlipLink(track);
  const message = `${track.title} — ${track.artist}\n${tfLink}\n\nDon’t have TuneFlip yet? ${TUNEFLIP_APPSTORE_URL}`;
  try { await Share.share({ message }); }
  catch (e) { Alert.alert("Share failed", e?.message || "Please try again."); }
}

// ===== Storage =====
const PROFILE_KEY = "tuneflip_profile_v1";
const LIKED_SONGS_KEY = "tuneflip_liked_v1";
const LIKED_DATES_KEY = "tuneflip_liked_dates_v1";
const DISLIKED_SONGS_KEY = "tuneflip_disliked_v1";

const loadProfile = async () => JSON.parse((await AsyncStorage.getItem(PROFILE_KEY)) || "null");
const saveProfile  = (p) => AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p));
const loadLiked    = async () => JSON.parse((await AsyncStorage.getItem(LIKED_SONGS_KEY)) || "[]");
const saveLiked    = (l) => AsyncStorage.setItem(LIKED_SONGS_KEY, JSON.stringify(l));
const loadLikedDates = async () => JSON.parse((await AsyncStorage.getItem(LIKED_DATES_KEY)) || "{}");
const saveLikedDates = (m) => AsyncStorage.setItem(LIKED_DATES_KEY, JSON.stringify(m));
const loadDisliked   = async () => JSON.parse((await AsyncStorage.getItem(DISLIKED_SONGS_KEY)) || "[]");
const saveDisliked   = (arr) => AsyncStorage.setItem(DISLIKED_SONGS_KEY, JSON.stringify(arr));

const dedupeById = (list) => { const seen=new Set(), out=[]; for (const t of list) { const k=trackKey(t); if(seen.has(k)) continue; seen.add(k); out.push(t);} return out; };

// ===== Edge-swipe wrapper =====
function EdgeBackWrapper({ onBack, children }) {
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (e, g) => g.moveX < 24 && g.dx > 6 && Math.abs(g.dy) < 24,
      onPanResponderRelease: (e, g) => { if (g.dx > 50) onBack?.(); },
    })
  ).current;
  return <View style={{ flex: 1 }} {...pan.panHandlers}>{children}</View>;
}

// ===== UI bits =====
function GenreBubbles({ allGenres, selected, onToggle }) {
  const genres = Array.isArray(allGenres) ? allGenres : [];
  if (genres.length === 0) return null;
  return (
    <View style={styles.bubblesWrap}>
      {genres.map((g) => {
        const on = selected.includes(g.id);
        return (
          <Pressable key={g.id} onPress={() => onToggle(g.id)} style={[styles.bubble, on && styles.bubbleOn]}>
            <Text style={[styles.bubbleText, on && styles.bubbleTextOn]}>{g.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProfileScreen({ onDone, onOpenLiked, onCancel, onGenresFetched }) {
  const [loadingGenres, setLoadingGenres] = useState(true);
  const [genres, setGenres] = useState([]);

  const [name, setName] = useState("");
    const [age, setAge] = useState("");
  const [gender, setGender] = useState("Prefer not to say");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [favoriteGenreIds, setFavoriteGenreIds] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const p = await loadProfile();
      if (live && p) {
        setName(p.name || ""); setAge(String(p.age || "")); setGender(p.gender || "Prefer not to say");
        setEmail(p.email || ""); setPassword(p.password || "");
        setFavoriteGenreIds(Array.isArray(p.favoriteGenreIds) ? p.favoriteGenreIds : []);
      }
      const gs = await fetchGenres();
      if (live) {
        setGenres(gs); onGenresFetched?.(gs);
        setLoadingGenres(false);
      }
    })();
    return () => { live = false; };
  }, [onGenresFetched]);

  const toggleGenre = useCallback((id) => {
    setFavoriteGenreIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);

  const save = useCallback(async () => {
    if (!name.trim()) return Alert.alert("Profile", "Please enter your name.");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return Alert.alert("Profile", "Please enter a valid email.");
    setSaving(true);
    try {
      await saveProfile({
        name: name.trim(), age: Number(age) || null, gender,
        email: email.trim(), password, favoriteGenreIds, savedAt: Date.now(),
      });
      onDone?.(); // Save & Apply -> refresh outside
    } catch (e) { Alert.alert("Save failed", e?.message || "Please try again."); }
    finally { setSaving(false); }
  }, [name, age, gender, email, password, favoriteGenreIds, onDone]);

  return (
    <EdgeBackWrapper onBack={onCancel}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0b0c" }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
            <Text style={styles.h1}>Your profile</Text>
            <Text style={styles.subtle}>Personalize your feed and quick actions.</Text>

            <Text style={styles.label}>Name</Text>
            <TextInput placeholder="Your name" placeholderTextColor="#888" style={styles.input} value={name} onChangeText={setName} />

            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Age</Text>
                <TextInput placeholder="e.g., 36" placeholderTextColor="#888" style={styles.input} inputMode="numeric" value={age} onChangeText={setAge} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Gender</Text>
                <View style={styles.segmentWrap}>
                  {["Male", "Female", "Non-binary", "Prefer not to say"].map((g) => (
                    <Pressable key={g} onPress={() => setGender(g)} style={[styles.segment, gender === g && styles.segmentOn]}>
                      <Text style={[styles.segmentText, gender === g && styles.segmentTextOn]}>{g}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>

            <Text style={styles.label}>Email</Text>
            <TextInput placeholder="you@example.com" placeholderTextColor="#888" autoCapitalize="none" keyboardType="email-address" style={styles.input} value={email} onChangeText={setEmail} />

            <Text style={styles.label}>Create password</Text>
            <TextInput placeholder="Choose a password" placeholderTextColor="#888" secureTextEntry style={styles.input} value={password} onChangeText={setPassword} />

            <Text style={[styles.label, { marginTop: 8 }]}>Favorite genres</Text>
            {loadingGenres ? <ActivityIndicator style={{ marginVertical: 12 }} /> :
              <GenreBubbles allGenres={genres} selected={favoriteGenreIds} onToggle={toggleGenre} />
            }

            <View style={{ height: 16 }} />
            <TouchableOpacity onPress={save} style={styles.primaryBtn} disabled={saving}>
              <Text style={styles.primaryBtnText}>{saving ? "Saving..." : "Save & Apply"}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onOpenLiked} style={[styles.secondaryBtn, { marginTop: 8 }]}>
              <Text style={styles.secondaryBtnText}>Liked Songs</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </EdgeBackWrapper>
  );
}

function LikedSongsScreen({ liked, onClose, onOpenInFeed, title = "Liked Songs" }) {
  return (
    <EdgeBackWrapper onBack={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0b0c" }}>
        <View style={styles.topBar}>
          <Text style={styles.brand}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.topBtn}><Text style={styles.topBtnText}>Close</Text></TouchableOpacity>
        </View>
        {liked.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#aaa" }}>No songs yet.</Text>
          </View>
        ) : (
          <FlatList
            data={liked}
            keyExtractor={(item) => trackKey(item).toString()}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => (
              <View style={styles.likedRow}>
                <Image source={{ uri: item.artwork }} style={styles.likedArt} />
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{item.artist}</Text>
                  <Text style={styles.metaDim} numberOfLines={1}>{item.album}</Text>
                </View>
                <TouchableOpacity style={styles.actionBtn} onPress={() => onOpenInFeed(item)}>
                  <Text style={styles.actionBtnText}>Go</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        )}
      </SafeAreaView>
    </EdgeBackWrapper>
  );
}

function GenresQuickScreen({ initialSelected = [], savedProfileGenreIds = [], onApply, onClose, onGenresFetched }) {
  const [loading, setLoading] = useState(true);
  const [genres, setGenres] = useState([]);
  const [selected, setSelected] = useState(initialSelected);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const gs = await fetchGenres();
        if (!live) return;
        setGenres(gs && gs.length ? gs : DEFAULT_GENRES);
        onGenresFetched?.(gs);
        const valid = new Set((gs || []).map(g => g.id));
        setSelected((prev) => (prev || []).filter((id) => valid.has(id)));
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [onGenresFetched]);

  const toggleGenre = (id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const resetToProfile = () => setSelected(Array.isArray(savedProfileGenreIds) ? savedProfileGenreIds : []);

  return (
    <EdgeBackWrapper onBack={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0b0c" }}>
        <View style={styles.topBar}>
          <Text style={styles.brand}>Choose Genres</Text>
          <TouchableOpacity onPress={onClose} style={styles.topBtn}><Text style={styles.topBtnText}>Close</Text></TouchableOpacity>
        </View>
        <View style={{ padding: 16 }}>
          {loading ? (
            <ActivityIndicator />
          ) : (
            <>
              <GenreBubbles allGenres={genres} selected={selected} onToggle={toggleGenre} />
              <View style={{ height: 12 }} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TouchableOpacity onPress={() => onApply?.(selected)} style={[styles.primaryBtn, { flex: 1 }]}>
                  <Text style={styles.primaryBtnText}>Apply</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={resetToProfile} style={[styles.secondaryBtn, { flex: 1 }]}>
                  <Text style={styles.secondaryBtnText}>Reset</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </SafeAreaView>
    </EdgeBackWrapper>
  );
}

// ===== Swipeable card =====
function TrackCard({
  item,
  isLiked,
  isDisliked,
  onSwipeDecision,
  onOpenPressed,
  onSharePressed,
  onToggleLike,
  onToggleDislike,
  onOpenSessionLikes,
  onOpenGenres,
  onOpenProfile,
  onBuyPressed,
  artworkUri,
}) {
  const translate = useRef(new Animated.Value(0)).current;
  const likePulse = useRef(new Animated.Value(1)).current;
  const nopePulse = useRef(new Animated.Value(1)).current;

  const rotate = translate.interpolate({ inputRange: [-160, 0, 160], outputRange: ["-10deg", "0deg", "10deg"] });
  const likeOpacity = translate.interpolate({ inputRange: [20, 120], outputRange: [0, 1], extrapolate: "clamp" });
  const nopeOpacity = translate.interpolate({ inputRange: [-120, -20], outputRange: [1, 0], extrapolate: "clamp" });
  const likeScale = translate.interpolate({ inputRange: [0, 60, 120, 200], outputRange: [1, 1.05, 1.15, 1.2], extrapolate: "clamp" });
  const nopeScale = translate.interpolate({ inputRange: [-200, -120, -60, 0], outputRange: [1.2, 1.15, 1.05, 1], extrapolate: "clamp" });

  const SWIPE_THRESHOLD = 120;
  const crossedRef = useRef("none");

  const pulse = (v) => Animated.sequence([
    Animated.timing(v, { toValue: 1.22, duration: 80, useNativeDriver: true }),
    Animated.spring(v, { toValue: 1, useNativeDriver: true }),
  ]).start();

  const springBack = () => Animated.spring(translate, { toValue: 0, useNativeDriver: true }).start();

  const commitSwipe = async (dir) => {
    await Haptics.notificationAsync(dir === "like" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    if (dir === "like") pulse(likePulse); else pulse(nopePulse);
    onSwipeDecision?.(dir);
    springBack();
    crossedRef.current = "none";
  };

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dy) < 24,
    onPanResponderMove: (_, g) => {
      translate.setValue(g.dx);
      if (g.dx > SWIPE_THRESHOLD && crossedRef.current !== "like") { crossedRef.current = "like"; Haptics.selectionAsync(); }
      else if (g.dx < -SWIPE_THRESHOLD && crossedRef.current !== "dislike") { crossedRef.current = "dislike"; Haptics.selectionAsync(); }
      else if (g.dx <= SWIPE_THRESHOLD && g.dx >= -SWIPE_THRESHOLD && crossedRef.current !== "none") { crossedRef.current = "none"; Haptics.selectionAsync(); }
    },
    onPanResponderRelease: (_, g) => {
      if (g.dx > SWIPE_THRESHOLD) return commitSwipe("like");
      if (g.dx < -SWIPE_THRESHOLD) return commitSwipe("dislike");
      springBack();
    },
    onPanResponderTerminate: springBack,
  })).current;

  return (
    <View style={{ height: CARD_HEIGHT, justifyContent: "center", alignItems: "center" }}>
      {/* Overlay quick controls */}
      <View pointerEvents="box-none" style={styles.overlayWrap}>
        <View style={styles.overlayRow}>
          <TouchableOpacity style={styles.overlayBtn} onPress={onOpenSessionLikes}>
            <Ionicons name="heart" size={16} color="white" />
            <Text style={styles.overlayBtnText}>Liked</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.overlayBtn} onPress={onOpenGenres}>
            <Ionicons name="musical-notes" size={16} color="white" />
            <Text style={styles.overlayBtnText}>Genres</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.overlayBtn} onPress={onOpenProfile}>
            <Ionicons name="person-circle" size={16} color="white" />
            <Text style={styles.overlayBtnText}>Profile</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX: translate }, { rotate }], alignItems: "center", width: "100%", paddingHorizontal: 18 }}>
        {/* Larger badges on top of cover */}
        <Animated.View style={[styles.iconBadge, styles.iconLeft, { opacity: likeOpacity, transform: [{ scale: likeScale }, { scale: likePulse }] }]}>
          <Ionicons name="thumbs-up" size={44} color="#3ee37a" />
        </Animated.View>
        <Animated.View style={[styles.iconBadge, styles.iconRight, { opacity: nopeOpacity, transform: [{ scale: nopeScale }, { scale: nopePulse }] }]}>
          <Ionicons name="thumbs-down" size={44} color="#ff6b6b" />
        </Animated.View>

        <Image
          source={{ uri: artworkUri || item.artwork }}
          style={{ width: screen.width * 0.86, height: screen.width * 0.86, resizeMode: "contain", marginTop: -CARD_HEIGHT * 0.12, zIndex: 1 }}
          {...(Platform.OS === "android" ? { fadeDuration: 0 } : {})}
        />
        <View style={{ marginTop: 14, alignItems: "center", paddingHorizontal: 8 }}>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.meta} numberOfLines={1}>{item.artist}</Text>
          <Text style={styles.metaDim} numberOfLines={1}>{item.album}</Text>
        </View>
      </Animated.View>

      {/* Buttons (toggleable) */}
      <View style={[styles.rowButtons, { justifyContent: "center", marginTop: 10 }]}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.nope, isDisliked && styles.nopeActive]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onToggleDislike?.(item, isDisliked); }}
        >
          <Ionicons name="thumbs-down" size={18} color="white" />
          <Text style={[styles.actionBtnText, { marginLeft: 6 }]}>Nope</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.like, isLiked && styles.likeActive]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onToggleLike?.(item, isLiked); }}
        >
          <Ionicons name="thumbs-up" size={18} color="white" />
          <Text style={[styles.actionBtnText, { marginLeft: 6 }]}>Like</Text>
        </TouchableOpacity>
        <View style={{ width: 8 }} />
        <TouchableOpacity style={styles.actionBtn} onPress={() => onOpenPressed?.(item)}><Text style={styles.actionBtnText}>Open…</Text></TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onSharePressed?.(item)}><Text style={styles.actionBtnText}>Share</Text></TouchableOpacity>
      </View>

      {/* Buy below, centered */}
      <View style={{ alignItems: "center", marginTop: 8 }}>
        <TouchableOpacity style={styles.buyBtn} onPress={() => onBuyPressed?.(item)}>
          <Ionicons name="cart" size={18} color="white" />
          <Text style={[styles.actionBtnText, { marginLeft: 6 }]}>Buy</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// =================== MAIN APP ===================
export default function App() {
  const [profile, setProfile] = useState(null);

  const [showProfile, setShowProfile] = useState(false);
  const [showLikedPersistent, setShowLikedPersistent] = useState(false);
  const [showLikedSession, setShowLikedSession] = useState(false);
  const [showGenresQuick, setShowGenresQuick] = useState(false);

  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [feedVersion, setFeedVersion] = useState(0);

  const [openModal, setOpenModal] = useState(false);
  const [openForTrack, setOpenForTrack] = useState(null);

  const [sessionLikes, setSessionLikes] = useState(0);
  const [likedPersistent, setLikedPersistent] = useState([]);
  const [likedSession, setLikedSession] = useState([]);
  const [opinionTick, setOpinionTick] = useState(0);

  const [sessionGenreIds, setSessionGenreIds] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchMode, setIsSearchMode] = useState(false);

  const soundRef = useRef(null);
  const playTokenRef = useRef(0);

  const preloadedRef = useRef(new Map());
  const preloadingSetRef = useRef(new Set());

  const listRef = useRef(null);

  // ARTWORK CACHE/PREFETCH
  const artworkCacheRef = useRef(new Map());     // originalUri -> localUri
  const artworkPrefetchingRef = useRef(new Set());
  const [artworkTick, setArtworkTick] = useState(0);

  // prevent re-autoplay when closing overlays
  const suppressNextAutoplayRef = useRef(false);

  const likeSet = useRef(new Set());
  const dislikeSet = useRef(new Set());

  const likedDatesRef = useRef({});
  const cutoffRef = useRef(0);

  const tracksRef = useRef(tracks);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  const dislikedPersistentRef = useRef(new Set());
  const likedPersistentSetRef = useRef(new Set());
  useEffect(() => {
    likedPersistentSetRef.current = new Set((likedPersistent || []).map((t) => trackKey(t)));
  }, [likedPersistent]);

  const genreNameByIdRef = useRef(new Map(DEFAULT_GENRES.map(g => [String(g.id), g.name])));

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const vi = viewableItems.find((v) => v.isViewable && v.index != null);
    if (vi?.index != null) setActiveIndex(vi.index);
  });
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 80, minimumViewTime: 100 });

  const stopAudio = useCallback(async () => {
    try {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
    } catch {}
  }, []);
  useEffect(() => () => { stopAudio(); cleanupPreloadedExcept(); }, [stopAudio]);

  const cleanupPreloadedExcept = useCallback((keepIdx = null) => {
    try {
      for (const [k, entry] of preloadedRef.current.entries()) {
        if (keepIdx !== k) {
          entry?.sound?.unloadAsync?.().catch(()=>{});
          preloadedRef.current.delete(k);
        }
      }
    } catch {}
  }, []);

  const isKaraoke = (t) => {
    const blob = `${t.title || ""} ${t.album || ""} ${t.artist || ""}`;
    return KARAOKE_PATTERNS.some((re) => re.test(blob));
  };
  const tooRecentlyLiked = (t) => {
    const id = trackKey(t);
    const last = likedDatesRef.current?.[id];
    return last && last > cutoffRef.current;
  };

  const matchesSelectedGenres = useCallback((t, ids) => {
    if (!ids || !ids.length) return true;
    const names = ids.map((id) => (genreNameByIdRef.current.get(String(id)) || "").toLowerCase()).filter(Boolean);
    const gn = (t.genreName || "").toLowerCase();
    if (!names.length || !gn) return true;
    return names.some((n) => gn.includes(n));
  }, []);

  const applyGlobalFilters = useCallback((arr, idsForTighten = []) => {
    if (!Array.isArray(arr)) return [];
    let list = arr.filter((t) => !isKaraoke(t));

    const withoutDisliked = list.filter((t) => !dislikedPersistentRef.current.has(trackKey(t)));
    list = withoutDisliked.length >= 5 ? withoutDisliked : list;

    let cooled = list.filter((t) => !tooRecentlyLiked(t));
    if (cooled.length < PAGE * 0.6) cooled = list;

    if (idsForTighten && idsForTighten.length) {
      const tightened = cooled.filter((t) => matchesSelectedGenres(t, idsForTighten));
      if (tightened.length >= Math.min(10, PAGE / 2)) cooled = tightened;
    }
    return cooled;
  }, [matchesSelectedGenres]);

  // ===== ARTWORK PREFETCHER =====
  const ensureArtworkPrefetched = useCallback(async (idx) => {
    if (idx == null || idx < 0 || idx >= (tracksRef.current?.length || 0)) return;
    const uri = tracksRef.current[idx]?.artwork;
    if (!uri) return;
    if (artworkCacheRef.current.has(uri) || artworkPrefetchingRef.current.has(uri)) return;

    artworkPrefetchingRef.current.add(uri);
    try {
      const asset = Asset.fromURI(uri);
      await asset.downloadAsync();
      const local = asset.localUri || asset.uri;
      if (local) {
        artworkCacheRef.current.set(uri, local);
        setArtworkTick((t) => t + 1);
      }
    } catch {} finally {
      artworkPrefetchingRef.current.delete(uri);
    }
  }, []);

  useEffect(() => {
    ensureArtworkPrefetched(activeIndex);
    ensureArtworkPrefetched(activeIndex + 1);
  }, [activeIndex, ensureArtworkPrefetched]);

  const refreshDiscoveryFeed = useCallback(
    async (explicitGenreIds = null) => {
      setLoading(true);
      try {
        await stopAudio();
        cleanupPreloadedExcept();

        const seed = makeSeed();
        const ids = (explicitGenreIds && explicitGenreIds.length
          ? explicitGenreIds
          : (sessionGenreIds && sessionGenreIds.length ? sessionGenreIds : (profile?.favoriteGenreIds || [])));

        let res = (ids && ids.length)
          ? await fetchTracksForGenres(ids, seed)
          : await fetchTracks(GENRE_FALLBACK, seed);

        res = applyGlobalFilters(res, ids);

        setIsSearchMode(false);
        setFeedVersion((v) => v + 1);
        setTracks(res);
        setActiveIndex(0);

        requestAnimationFrame(() => {
          listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
        });

        setTimeout(() => { ensureArtworkPrefetched(0); ensureArtworkPrefetched(1); }, 0);

        await sleep(80);
        await playPreview(0);
      } catch (e) {
        Alert.alert("Feed", `Could not refresh your feed.\n${String(e?.message || e)}`);
      } finally {
        setLoading(false);
      }
    },
    [sessionGenreIds, profile, stopAudio, cleanupPreloadedExcept, applyGlobalFilters, ensureArtworkPrefetched]
  );

  // Close overlays without refreshing (keeps playing)
  const closeOverlaysNoRefresh = useCallback(() => {
    suppressNextAutoplayRef.current = true; // <<< prevent re-autoplay on re-mount
    setShowGenresQuick(false);
    setShowLikedSession(false);
    setShowLikedPersistent(false);
    setShowProfile(false);
  }, []);

  // Back / hardware handling — close overlays first (no refresh, no autoplay), then exit search
  useEffect(() => {
    const onBack = () => {
      if (openModal) { setOpenModal(false); return true; }

      if (showGenresQuick) { suppressNextAutoplayRef.current = true; setShowGenresQuick(false); return true; }
      if (showLikedSession) { suppressNextAutoplayRef.current = true; setShowLikedSession(false); return true; }
      if (showLikedPersistent) { suppressNextAutoplayRef.current = true; setShowLikedPersistent(false); return true; }
      if (showProfile) { suppressNextAutoplayRef.current = true; setShowProfile(false); return true; }

      if (isSearchMode) { // back from Search -> refresh to discovery
        exitSearch(); 
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [openModal, isSearchMode, showGenresQuick, showLikedSession, showLikedPersistent, showProfile]);

  // Initial load
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });

        const disliked = await loadDisliked();
        dislikedPersistentRef.current = new Set((disliked || []).map(String));

        likedDatesRef.current = await loadLikedDates();
        cutoffRef.current = Date.now() - LIKE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

        const p = await loadProfile();
        const liked = await loadLiked();
        if (!live) return;
        setProfile(p);
        setLikedPersistent(dedupeById(liked));

        try {
          const serverGenres = await fetchGenres();
          const m = new Map(DEFAULT_GENRES.map(g => [String(g.id), g.name]));
          for (const g of serverGenres) m.set(String(g.id), g.name);
          genreNameByIdRef.current = m;
        } catch {}

        const startSeed = makeSeed();
        const startIds = (p?.favoriteGenreIds && p.favoriteGenreIds.length) ? p.favoriteGenreIds : [GENRE_FALLBACK];
        let initial = await fetchTracksForGenres(startIds, startSeed);
        initial = applyGlobalFilters(initial, startIds);
        if (live) {
          setTracks(initial);
          setActiveIndex(0);

          setTimeout(() => { ensureArtworkPrefetched(0); ensureArtworkPrefetched(1); }, 0);

          await sleep(80);
          await playPreview(0);
        }
      } catch (e) {
        Alert.alert("Feed", `Could not load music.\n${String(e?.message || e)}`);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [applyGlobalFilters, ensureArtworkPrefetched]);

  // Audio preloading
  const preloadIndex = useCallback(async (idx) => {
    if (idx == null || idx < 0 || idx >= tracksRef.current.length) return;
    const uri = tracksRef.current[idx]?.previewUrl;
    if (!uri) return;
    if (preloadedRef.current.has(idx)) return;
    if (preloadingSetRef.current.has(idx)) return;

    preloadingSetRef.current.add(idx);
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false, volume: 1.0, isLooping: false }
      );
      preloadedRef.current.set(idx, { sound, uri });
      cleanupPreloadedExcept(idx);
    } catch {} finally {
      preloadingSetRef.current.delete(idx);
    }
  }, [cleanupPreloadedExcept]);

  const playPreview = useCallback(async (index) => {
    const list = tracksRef.current;
    if (!list[index]?.previewUrl) { await stopAudio(); return; }
    const token = ++playTokenRef.current;

    const pre = preloadedRef.current.get(index);
    try {
      await stopAudio();

      if (pre && pre.uri === list[index].previewUrl) {
        soundRef.current = pre.sound;
        preloadedRef.current.delete(index);
        await soundRef.current.setPositionAsync(0);
        await soundRef.current.playAsync();
      } else {
        const { sound } = await Audio.Sound.createAsync(
          { uri: list[index].previewUrl },
          { shouldPlay: true, volume: 1.0, isLooping: false }
        );
        if (playTokenRef.current !== token) { await sound.unloadAsync(); return; }
        soundRef.current = sound;
      }
    } catch {}

    const nextIdx = index + 1;
    preloadIndex(nextIdx);
    ensureArtworkPrefetched(nextIdx);
  }, [stopAudio, preloadIndex, ensureArtworkPrefetched]);

  // IMPORTANT: skip autoplay when closing overlays (no reset)
  useEffect(() => {
    (async () => {
      if (suppressNextAutoplayRef.current) {
        suppressNextAutoplayRef.current = false;
        return; // keep current song playing exactly as-is
      }
      await playPreview(activeIndex);
    })();
  }, [activeIndex, playPreview]);

  const handleOpenPressed = useCallback((track) => { setOpenForTrack(track); setOpenModal(true); }, []);
  const handleSharePressed = useCallback((track) => { shareTrack(track); }, []);
  const handleBuyPressed = useCallback((track) => { openStore(track); }, []);

  // Like / Dislike
  const markLikedTimestamp = useCallback(async (t) => {
    const id = trackKey(t);
    const map = { ...(likedDatesRef.current || {}) };
    map[id] = Date.now();
    likedDatesRef.current = map;
    try { await saveLikedDates(map); } catch {}
  }, []);

  const persistAddLike = useCallback(async (t) => {
    const k = trackKey(t);
    if (dislikedPersistentRef.current.has(k)) {
      dislikedPersistentRef.current.delete(k);
      saveDisliked(Array.from(dislikedPersistentRef.current)).catch(()=>{});
    }
    setLikedPersistent((prev) => {
      const updated = dedupeById([t, ...prev]);
      likedPersistentSetRef.current.add(k);
      saveLiked(updated).catch(()=>{});
      return updated;
    });
    markLikedTimestamp(t);
  }, [markLikedTimestamp]);

  const addSessionLike = useCallback((t) => {
    const k = trackKey(t);
    if (!likeSet.current.has(k)) {
      likeSet.current.add(k);
      setSessionLikes((n) => n + 1);
    }
    setLikedSession((prev) => (prev.find(x => trackKey(x) === k) ? prev : [t, ...prev]));
  }, []);

  const removeFromLikesEverywhere = useCallback((t) => {
    const k = trackKey(t);
    if (likeSet.current.has(k)) {
      likeSet.current.delete(k);
      setSessionLikes((n) => Math.max(0, n - 1));
    }
    likedPersistentSetRef.current.delete(k);
    setLikedSession((prev) => prev.filter((x) => trackKey(x) !== k));
    setLikedPersistent((prev) => {
      const updated = prev.filter((x) => trackKey(x) !== k);
      saveLiked(updated).catch(()=>{});
      return updated;
    });
  }, []);

  const onLike = useCallback((t) => {
    const k = trackKey(t);
    if (dislikeSet.current.has(k)) dislikeSet.current.delete(k);
    addSessionLike(t);
    persistAddLike(t);
    setOpinionTick((x) => x + 1);
  }, [addSessionLike, persistAddLike]);

  const onDislike = useCallback((t) => {
    const k = trackKey(t);
    removeFromLikesEverywhere(t);
    dislikeSet.current.add(k);
    if (!dislikedPersistentRef.current.has(k)) {
      dislikedPersistentRef.current.add(k);
      saveDisliked(Array.from(dislikedPersistentRef.current)).catch(()=>{});
    }
    setOpinionTick((x) => x + 1);
  }, [removeFromLikesEverywhere]);

  const onToggleLike = useCallback((t, currentlyLiked) => {
    if (currentlyLiked) { removeFromLikesEverywhere(t); setOpinionTick((x) => x + 1); return; }
    onLike(t);
  }, [onLike, removeFromLikesEverywhere]);

  const onToggleDislike = useCallback((t, currentlyDisliked) => {
    const k = trackKey(t);
    if (currentlyDisliked) {
      dislikeSet.current.delete(k);
      if (dislikedPersistentRef.current.has(k)) {
        dislikedPersistentRef.current.delete(k);
        saveDisliked(Array.from(dislikedPersistentRef.current)).catch(()=>{});
      }
      setOpinionTick((x) => x + 1);
      return;
    }
    onDislike(t);
  }, [onDislike]);

  const refreshForProfile = useCallback(async () => {
    setShowProfile(false); setShowLikedPersistent(false); setShowGenresQuick(false);
    await refreshDiscoveryFeed(profile?.favoriteGenreIds || []);
  }, [refreshDiscoveryFeed, profile?.favoriteGenreIds]);

  const applySessionGenres = useCallback(async (ids) => {
    const selected = Array.isArray(ids) ? ids.filter(Boolean) : [];
    setShowGenresQuick(false);
    setSessionGenreIds(selected);
    await refreshDiscoveryFeed(selected);
  }, [refreshDiscoveryFeed]);

  // Go from Liked
  const waitForIndexById = useCallback(async (id, tries = 12, delay = 40) => {
    for (let k = 0; k < tries; k++) {
      const idx = tracksRef.current.findIndex((t) => trackKey(t) === id);
      if (idx >= 0) return idx;
      await sleep(delay);
    }
    return -1;
  }, []);

  const openLikedInFeed = useCallback(async (track) => {
    const id = trackKey(track);
    await stopAudio();

    let idx = tracksRef.current.findIndex((t) => trackKey(t) === id);
    if (idx === -1) {
      const newList = [track, ...tracksRef.current];
      setTracks(newList);
      setFeedVersion((v) => v + 1);
      idx = 0;
    }

    setShowLikedSession(false); setShowLikedPersistent(false); setShowGenresQuick(false); setShowProfile(false);

    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset?.({ offset: idx * CARD_HEIGHT, animated: true });
    });

    const finalIdx = await waitForIndexById(id);
    if (finalIdx >= 0) {
      setActiveIndex(finalIdx);
      ensureArtworkPrefetched(finalIdx);
      await sleep(120);
      await playPreview(finalIdx);
    }
  }, [stopAudio, waitForIndexById, playPreview, ensureArtworkPrefetched]);

  // Deep-links
  const handleDeepLink = useCallback(async (url) => {
    try {
      const parsed = Linking.parse(url);
      const path = (parsed?.path || "").replace(/^\//, "");
      if (path !== "track") return;

      const q = parsed?.queryParams || {};
      const track = {
        id: q.id || undefined,
        title: q.title || "",
        artist: q.artist || "",
        album: q.album || "",
        artwork: q.artwork ? decodeURIComponent(q.artwork) : "",
        previewUrl: q.previewUrl ? decodeURIComponent(q.previewUrl) : "",
        storeUrl: q.storeUrl ? decodeURIComponent(q.storeUrl) : ""
      };

      await openLikedInFeed(track);
    } catch {}
  }, [openLikedInFeed]);

  useEffect(() => {
    const sub = Linking.addEventListener("url", ({ url }) => handleDeepLink(url));
    (async () => {
      const initial = await Linking.getInitialURL();
      if (initial) handleDeepLink(initial);
    })();
    return () => sub.remove();
  }, [handleDeepLink]);

  const onGenresFetched = useCallback((arr) => {
    try {
      const m = new Map(DEFAULT_GENRES.map(g => [String(g.id), g.name]));
      for (const g of (arr || [])) m.set(String(g.id), g.name);
      genreNameByIdRef.current = m;
    } catch {}
  }, []);

  // ---- Search mode ----
  const performSearch = useCallback(async () => {
    const q = (searchQuery || "").trim();
    if (!q) return;
    setLoading(true);
    try {
      await stopAudio();
      cleanupPreloadedExcept();

      const res = await fetchSearchTracks(q, makeSeed());

      const filtered = (res || [])
        .filter((t) => !KARAOKE_PATTERNS.some((re) => re.test(`${t.title} ${t.album} ${t.artist}`)))
        .filter((t) => !dislikedPersistentRef.current.has(trackKey(t)));

      setIsSearchMode(true);
      setFeedVersion((v) => v + 1);
      setTracks(filtered);
      setActiveIndex(0);

      requestAnimationFrame(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: false }));
      setTimeout(() => { ensureArtworkPrefetched(0); ensureArtworkPrefetched(1); }, 0);
      await sleep(80);
      await playPreview(0);
    } catch (e) {
      Alert.alert("Search", `Could not load results.\n${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, stopAudio, cleanupPreloadedExcept, playPreview, ensureArtworkPrefetched]);

  const exitSearch = useCallback(() => {
    setSearchQuery("");
    setIsSearchMode(false);
    refreshDiscoveryFeed();
  }, [refreshDiscoveryFeed]);

  const openSessionLikesList = useCallback(() => { setShowProfile(false); setShowGenresQuick(false); setShowLikedPersistent(false); setShowLikedSession(true); }, []);
  const openGenresQuickList = useCallback(() => { setShowProfile(false); setShowLikedSession(false); setShowLikedPersistent(false); setShowGenresQuick(true); }, []);
  const openProfileFull = useCallback(() => { setShowLikedSession(false); setShowLikedPersistent(false); setShowGenresQuick(false); setShowProfile(true); }, []);

  // Screens
  if (showProfile) return (
    <ProfileScreen
      onDone={refreshForProfile}               // Save & Apply -> refresh
      onOpenLiked={() => { setShowProfile(false); setShowLikedPersistent(true); }}
      onCancel={closeOverlaysNoRefresh}        // Close/back -> NO refresh and NO re-autoplay
      onGenresFetched={onGenresFetched}
    />
  );
  if (showGenresQuick) return (
    <GenresQuickScreen
      initialSelected={sessionGenreIds ?? (profile?.favoriteGenreIds ?? [])}
      savedProfileGenreIds={profile?.favoriteGenreIds ?? []}
      onApply={applySessionGenres}             // Apply -> refresh
      onClose={closeOverlaysNoRefresh}         // Close/back -> NO refresh and NO re-autoplay
      onGenresFetched={onGenresFetched}
    />
  );
  if (showLikedPersistent) return <LikedSongsScreen title="Liked Songs (All)" liked={likedPersistent} onClose={closeOverlaysNoRefresh} onOpenInFeed={openLikedInFeed} />;
  if (showLikedSession)    return <LikedSongsScreen title="Session Likes"      liked={likedSession}    onClose={closeOverlaysNoRefresh} onOpenInFeed={openLikedInFeed} />;

  const renderEmpty = !loading && tracks.length === 0;
  const resolvedArtworkFor = (item) => artworkCacheRef.current.get(item.artwork) || item.artwork;

  const isLikedKey = (k) => likeSet.current.has(k) || likedPersistentSetRef.current.has(k);
  const isDislikedKey = (k) => dislikeSet.current.has(k) || dislikedPersistentRef.current.has(k);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0b0c" }}>
      <View style={[styles.topBar, { height: 48 }]}>
        <Text style={styles.brand}>TuneFlip</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <View style={styles.pill}><Text style={styles.pillText}>Session Likes: {sessionLikes}</Text></View>
        </View>
      </View>

      {/* Search row (compact) */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search songs, artists, albums"
            placeholderTextColor="#888"
            style={styles.searchInput}
            returnKeyType="search"
            onSubmitEditing={performSearch}
          />
          {!!searchQuery && (
            <Pressable onPress={() => { setSearchQuery(""); if (isSearchMode) exitSearch(); }} style={{ padding: 6 }}>
              <Ionicons name="close" size={16} color="#bbb" />
            </Pressable>
          )}
          <Pressable onPress={performSearch} style={{ padding: 6, marginLeft: 2 }}>
            <Ionicons name="search" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={{ flex:1, alignItems:"center", justifyContent:"center" }}>
          <ActivityIndicator />
        </View>
      ) : renderEmpty ? (
        <View style={{ flex:1, alignItems:"center", justifyContent:"center", gap:12 }}>
          <Text style={{ color:"#aaa", textAlign:"center", paddingHorizontal:24 }}>
            {isSearchMode ? "No results for your search." : "No tracks loaded."}
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => isSearchMode ? performSearch() : refreshDiscoveryFeed()}>
            <Text style={styles.primaryBtnText}>{isSearchMode ? "Try Again" : "Retry"}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          listKey={String(feedVersion)}
          extraData={{ opinionTick, feedVersion, artworkTick }}
          data={tracks}
          keyExtractor={(item, index) => `${trackKey(item)}-${feedVersion}-${index}`}
          initialScrollIndex={activeIndex}                        // keep same card visible on re-mount
          getItemLayout={(_, index) => ({ length: CARD_HEIGHT, offset: CARD_HEIGHT * index, index })}
          renderItem={({ item }) => {
            const k = trackKey(item);
            return (
              <TrackCard
                item={item}
                isLiked={isLikedKey(k)}
                isDisliked={isDislikedKey(k)}
                onSwipeDecision={(dir) => { if (dir === "like") onLike(item); else onDislike(item); }}
                onOpenPressed={(t) => setOpenModal(true) || setOpenForTrack(t)}
                onSharePressed={(t) => shareTrack(t)}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                onOpenSessionLikes={openSessionLikesList}
                onOpenGenres={openGenresQuickList}
                onOpenProfile={openProfileFull}
                onBuyPressed={handleBuyPressed}
                artworkUri={resolvedArtworkFor(item)}
              />
            );
          }}
          pagingEnabled
          decelerationRate="fast"
          snapToInterval={CARD_HEIGHT}
          snapToAlignment="start"
          onViewableItemsChanged={onViewableItemsChanged.current}
          viewabilityConfig={viewabilityConfigRef.current}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onMomentumScrollEnd={() => {
            const idx = activeIndex + 1;
            setTimeout(() => {
              preloadIndex(idx);
              ensureArtworkPrefetched(idx);
            }, 30);
          }}
        />
      )}

      <Modal visible={openModal} transparent animationType="fade" onRequestClose={() => setOpenModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpenModal(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Open in</Text>
            <Pressable style={styles.modalItem} onPress={() => { openInService(openForTrack, "itunes"); setOpenModal(false); }}>
              <Text style={styles.modalItemText}>Apple Music / iTunes</Text>
            </Pressable>
            <Pressable style={styles.modalItem} onPress={() => { openInService(openForTrack, "spotify"); setOpenModal(false); }}>
              <Text style={styles.modalItemText}>Spotify</Text>
            </Pressable>
            <Pressable style={styles.modalItem} onPress={() => { openInService(openForTrack, "ytmusic"); setOpenModal(false); }}>
              <Text style={styles.modalItemText}>YouTube Music</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ===== Styles =====
const styles = StyleSheet.create({
  topBar: { height: 52, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { color: "white", fontSize: 20, fontWeight: "700", letterSpacing: 0.3 },

  pill: { backgroundColor: "#2e5cff", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  pillText: { color: "white", fontWeight: "700", fontSize: 12 },

  // Search UI (compact)
  searchRow: { paddingHorizontal: 12, paddingBottom: 4 },
  searchBox: { backgroundColor: "#141418", borderWidth: 1, borderColor: "#2a2a31", borderRadius: 12, paddingHorizontal: 10, paddingVertical: Platform.OS === "ios" ? 8 : 6, flexDirection: "row", alignItems: "center", gap: 8 },
  searchInput: { color: "white", flex: 1, paddingVertical: 0 },

  title: { color: "white", fontSize: 18, fontWeight: "700" },
  meta: { color: "#e8e8ea", marginTop: 2, fontSize: 14 },
  metaDim: { color: "#aaa", marginTop: 2, fontSize: 13 },

  // Overlay controls
  overlayWrap: { position: "absolute", top: 20, left: 0, right: 0, alignItems: "center", zIndex: 5 },
  overlayRow: { flexDirection: "row", gap: 10, backgroundColor: "rgba(0,0,0,0.25)", padding: 6, borderRadius: 999 },
  overlayBtn: { backgroundColor: "#1f1f23", borderWidth: 1, borderColor: "#2a2a31", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, flexDirection: "row", alignItems: "center", gap: 6 },
  overlayBtnText: { color: "white", fontWeight: "700", fontSize: 12 },

  rowButtons: { flexDirection: "row", gap: 8, marginTop: 16 },
  actionBtn: { backgroundColor: "#1f1f23", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "transparent" },
  like: { backgroundColor: "#224d2a" },
  likeActive: { backgroundColor: "#2f7a44", borderColor: "#3ee37a" },
  nope: { backgroundColor: "#4d2222" },
  nopeActive: { backgroundColor: "#7a2f2f", borderColor: "#ff6b6b" },
  actionBtnText: { color: "white", fontWeight: "600" },

  iconBadge: { position: "absolute", top: 18, padding: 8, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.22)", zIndex: 20, elevation: 20 },
  iconLeft: { left: 18 },
  iconRight: { right: 18 },

  // Profile
  h1: { color: "white", fontSize: 22, fontWeight: "800", marginBottom: 4 },
  subtle: { color: "#9aa", marginBottom: 16 },
  label: { color: "#d8d8da", marginTop: 12, marginBottom: 6, fontWeight: "600" },
  input: { backgroundColor: "#151517", color: "white", borderRadius: 12, paddingHorizontal: 12, paddingVertical: Platform.OS === "ios" ? 12 : 10, borderWidth: 1, borderColor: "#222" },
  segmentWrap: { backgroundColor: "#151517", borderRadius: 12, flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 6, borderWidth: 1, borderColor: "#222" },
  segment: { paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#1b1b1f", borderRadius: 10 },
  segmentOn: { backgroundColor: "#2e5cff" },
  segmentText: { color: "#d0d0d4", fontSize: 12 },
  segmentTextOn: { color: "white", fontWeight: "700" },

  // Genre bubbles
  bubblesWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#141418", borderWidth: 1, borderColor: "#2a2a31", borderRadius: 999 },
  bubbleOn: { backgroundColor: "#2e5cff", borderColor: "#2e5cff" },
  bubbleText: { color: "#cbd", fontSize: 13 },
  bubbleTextOn: { color: "white", fontWeight: "700" },

  primaryBtn: { backgroundColor: "#2e5cff", paddingVertical: 12, alignItems: "center", borderRadius: 14 },
  primaryBtnText: { color: "white", fontSize: 16, fontWeight: "700" },
  secondaryBtn: { backgroundColor: "#1f1f23", paddingVertical: 12, alignItems: "center", borderRadius: 14 },
  secondaryBtnText: { color: "white", fontSize: 16, fontWeight: "700" },

  likedRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#141418", borderRadius: 12, padding: 8, borderWidth: 1, borderColor: "#26262e" },
  likedArt: { width: 54, height: 54, borderRadius: 8, backgroundColor: "#222" },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#1a1a1e", padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  modalTitle: { color: "white", fontWeight: "800", fontSize: 16, marginBottom: 6 },
  modalItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2b2b31" },
  modalItemText: { color: "white", fontSize: 15 },

  topBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  topBtnText: { color: "#fff" },

  // Buy button
  buyBtn: { alignItems: "center", flexDirection: "row", justifyContent: "center", backgroundColor: "#1f1f23", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: "transparent" },
});
