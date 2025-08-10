
// App.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Image, StyleSheet, Dimensions, TouchableOpacity,
  FlatList, AppState, ActivityIndicator, BackHandler, Modal,
  TextInput, Pressable, Animated
} from 'react-native';
import { Audio } from 'expo-av';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome } from '@expo/vector-icons';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
} from 'react-native-gesture-handler';

const { height, width } = Dimensions.get('window');
const COVER_SIZE = Math.min(width * 0.86, height * 0.56); // square cover
const COVER_TOP_OFFSET = height * 0.14;                   // a little above mid

const BASE = 'https://tuneflip-spotify-proxy.vercel.app';
const DEFAULT_GENRE = 21; // Rock
const PAGE = 20;
const sessionSeed = Math.floor(Math.random() * 1e9);

const KEYS = {
  likes: '@tuneflip/likes',
  dislikes: '@tuneflip/dislikes',
  likedItems: '@tuneflip/likedItems',
  genreId: '@tuneflip/genreId',
};

const DEMOS = [
  {
    id: 'demo-1',
    title: 'SoundHelix Song 1 (demo)',
    artist: 'SoundHelix • Demo',
    album: 'Demo Pack',
    albumArtUrl: 'https://picsum.photos/seed/demo1/1200/1200',
    previewUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    storeUrl: 'https://www.soundhelix.com/examples',
    source: 'demo',
  },
  {
    id: 'demo-2',
    title: 'Future Bass (demo)',
    artist: 'Pixabay • Demo',
    album: 'Demo Pack',
    albumArtUrl: 'https://picsum.photos/seed/demo2/1200/1200',
    previewUrl:
      'https://cdn.pixabay.com/download/audio/2022/10/21/audio_3bb3fefc2e.mp3?filename=future-bass-12457.mp3',
    storeUrl: 'https://pixabay.com/music/',
    source: 'demo',
  },
];

// ---------- helpers ----------
function diversify(items, { maxPerArtist = 2, cooldown = 3, target = PAGE }) {
  const result = [];
  const countByArtist = new Map();
  for (const it of items) {
    const a = (it.artist || '').trim().toLowerCase();
    const c = countByArtist.get(a) || 0;
    if (c >= maxPerArtist) continue;
    const tooSoon = result.slice(-cooldown).some(r => (r.artist || '').trim().toLowerCase() === a);
    if (tooSoon) continue;
    result.push(it);
    countByArtist.set(a, c + 1);
    if (result.length >= target) break;
  }
  if (result.length < target) {
    for (const it of items) {
      if (result.includes(it)) continue;
      const a = (it.artist || '').trim().toLowerCase();
      const c = countByArtist.get(a) || 0;
      if (c >= maxPerArtist) continue;
      result.push(it);
      countByArtist.set(a, c + 1);
      if (result.length >= target) break;
    }
  }
  return result;
}

function biasAndDiversify(items, { likedArtists, dislikedArtists, target = PAGE }) {
  const scored = items.map(it => {
    const a = (it.artist || '').trim().toLowerCase();
    let score = 0;
    if (likedArtists.has(a)) score += 2;
    if (dislikedArtists.has(a)) score -= 2;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return diversify(scored.map(s => s.it), { maxPerArtist: 2, cooldown: 3, target });
}

async function fetchTracks({ genreId, limit = PAGE }) {
  const url =
    `${BASE}/api/itunes-search?genreId=${encodeURIComponent(String(genreId))}` +
    `&limit=${encodeURIComponent(String(Math.max(limit, PAGE * 3)))}` +
    `&seed=${encodeURIComponent(String(sessionSeed))}` +
    `&t=${Date.now()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  const items = Array.isArray(json?.items) ? json.items : [];
  const seen = new Set();
  const mapped = [];
  for (const it of items) {
    const k = `${(it.title || '').trim()}|${(it.artist || '').trim()}|${(it.album || '').trim()}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    mapped.push(it);
  }
  return mapped.length ? mapped : DEMOS;
}

async function fetchGenres() {
  try {
    const r = await fetch(`${BASE}/api/itunes-genres?t=${Date.now()}`);
    if (!r.ok) throw new Error('genres fetch failed');
    const json = await r.json();
    const arr = Array.isArray(json?.items) ? json.items : [];
    if (arr.length) return arr;
  } catch {}
  // Small fallback set if endpoint fails
  return [
    { id: '20', name: 'Alternative', label: 'Music ▸ Alternative' },
    { id: '6', name: 'Country', label: 'Music ▸ Country' },
    { id: '14', name: 'Pop', label: 'Music ▸ Pop' },
    { id: '21', name: 'Rock', label: 'Music ▸ Rock' },
    { id: '15', name: 'R&B/Soul', label: 'Music ▸ R&B/Soul' },
    { id: '18', name: 'Hip-Hop/Rap', label: 'Music ▸ Hip-Hop/Rap' },
  ];
}

// ---------- component ----------
export default function App() {
  // state
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [likes, setLikes] = useState(() => new Set());
  const [dislikes, setDislikes] = useState(() => new Set());
  const [likedItems, setLikedItems] = useState({}); // id -> { id, title, artist, album, albumArtUrl, storeUrl }
  const [genreId, setGenreId] = useState(DEFAULT_GENRE);

  // refs (mutable mirrors for instant reads)
  const likesRef = useRef(new Set());
  const dislikesRef = useRef(new Set());
  const likedItemsRef = useRef({});
  const listRef = useRef(null);

  // UI state
  const [genres, setGenres] = useState([]);
  const [genreModal, setGenreModal] = useState(false);
  const [genreQuery, setGenreQuery] = useState('');
  const [likedModal, setLikedModal] = useState(false);

  // audio + playback control
  const soundRef = useRef(null);
  const currentIndexRef = useRef(0);
  const playTokenRef = useRef(0); // prevents overlapping sounds

  // --- Horizontal swipe gesture (Like/Dislike only) ---
  const panX = useRef(new Animated.Value(0)).current;
  const SWIPE_TRIGGER = 120;
  const likeOpacity = panX.interpolate({ inputRange: [10, 120], outputRange: [0, 1], extrapolate: 'clamp' });
  const dislikeOpacity = panX.interpolate({ inputRange: [-120, -10], outputRange: [1, 0], extrapolate: 'clamp' });
  const likeScale = panX.interpolate({ inputRange: [10, 120], outputRange: [0.9, 1.2], extrapolate: 'clamp' });
  const dislikeScale = panX.interpolate({ inputRange: [-120, -10], outputRange: [1.2, 0.9], extrapolate: 'clamp' });

  const onPanGestureEvent = Animated.event([{ nativeEvent: { translationX: panX } }], { useNativeDriver: true });
  const onPanStateChange = ({ nativeEvent }) => {
    if (nativeEvent.oldState === State.ACTIVE || nativeEvent.state === State.END) {
      const tx = nativeEvent.translationX || 0;
      if (tx > SWIPE_TRIGGER) applySwipe('like');
      else if (tx < -SWIPE_TRIGGER) applySwipe('dislike');
      Animated.spring(panX, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
    }
  };

  // --- Persistence: load once ---
  useEffect(() => {
    (async () => {
      try {
        const [ls, ds, li, gi] = await Promise.all([
          AsyncStorage.getItem(KEYS.likes),
          AsyncStorage.getItem(KEYS.dislikes),
          AsyncStorage.getItem(KEYS.likedItems),
          AsyncStorage.getItem(KEYS.genreId),
        ]);
        if (ls) { const s = new Set(JSON.parse(ls)); setLikes(s); likesRef.current = s; }
        if (ds) { const s = new Set(JSON.parse(ds)); setDislikes(s); dislikesRef.current = s; }
        if (li) { const o = JSON.parse(li) || {}; setLikedItems(o); likedItemsRef.current = o; }
        if (gi) setGenreId(Number(gi) || DEFAULT_GENRE);
      } catch {}
    })();
  }, []);
  // Save on changes
  useEffect(() => { likesRef.current = likes; AsyncStorage.setItem(KEYS.likes, JSON.stringify([...likes])); }, [likes]);
  useEffect(() => { dislikesRef.current = dislikes; AsyncStorage.setItem(KEYS.dislikes, JSON.stringify([...dislikes])); }, [dislikes]);
  useEffect(() => { likedItemsRef.current = likedItems; AsyncStorage.setItem(KEYS.likedItems, JSON.stringify(likedItems)); }, [likedItems]);
  useEffect(() => { AsyncStorage.setItem(KEYS.genreId, String(genreId)); }, [genreId]);

  // --- Audio mode ---
  useEffect(() => {
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch (e) { console.warn('Audio mode error', e); }
    })();
  }, []);

  // --- Load genres once ---
  useEffect(() => { (async () => setGenres(await fetchGenres()))(); }, []);

  // --- Reaction (mutually exclusive) ---
  const setReaction = useCallback((id, type /* 'like' | 'dislike' | null */, itemMeta) => {
    const nextLikes = new Set(likesRef.current);
    const nextDislikes = new Set(dislikesRef.current);
    const nextLikedItems = { ...likedItemsRef.current };

    nextLikes.delete(id);
    nextDislikes.delete(id);

    if (type === 'like') {
      nextLikes.add(id);
      if (itemMeta) nextLikedItems[id] = {
        id,
        title: itemMeta.title,
        artist: itemMeta.artist,
        album: itemMeta.album,
        albumArtUrl: itemMeta.albumArtUrl,
        storeUrl: itemMeta.storeUrl,
      };
    } else {
      delete nextLikedItems[id];
      if (type === 'dislike') nextDislikes.add(id);
    }

    likesRef.current = nextLikes;
    dislikesRef.current = nextDislikes;
    likedItemsRef.current = nextLikedItems;
    setLikes(nextLikes);
    setDislikes(nextDislikes);
    setLikedItems(nextLikedItems);
  }, []);

  // --- Swipes apply reactions (no skipping) ---
  const applySwipe = useCallback((type) => {
    const idx = currentIndexRef.current;
    const item = tracks[idx];
    if (!item) return;
    setReaction(item.id, type === 'like' ? 'like' : 'dislike', item);
  }, [tracks, setReaction]);

  // --- Fetch feed (respect likes/dislikes for bias + diversity) ---
  const reloadTracks = useCallback(async (gid) => {
    setLoading(true);
    try {
      const batch = await fetchTracks({ genreId: gid, limit: PAGE * 3 });
      const idToArtist = new Map(batch.map(x => [String(x.id), (x.artist || '').trim().toLowerCase()]));
      const likedArtists = new Set([...likesRef.current].map(id => idToArtist.get(String(id))).filter(Boolean));
      const dislikedArtists = new Set([...dislikesRef.current].map(id => idToArtist.get(String(id))).filter(Boolean));
      const finalList = biasAndDiversify(batch, { likedArtists, dislikedArtists, target: PAGE });
      setTracks(finalList);
    } catch (e) {
      console.warn('fetch error', e);
      setTracks(DEMOS);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reloadTracks(genreId); }, [genreId, reloadTracks]);

  // --- Playback (tokenized to avoid overlaps) ---
  const playItem = useCallback(async (item, indexForRef = null) => {
    const myToken = ++playTokenRef.current;
    try {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
    } catch {}

    if (indexForRef !== null) currentIndexRef.current = indexForRef;
    if (!item?.previewUrl) return;

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: item.previewUrl },
        { shouldPlay: true, isMuted: false, volume: 1.0 }
      );
      if (myToken !== playTokenRef.current) {
        try { await sound.stopAsync(); } catch {}
        try { await sound.unloadAsync(); } catch {}
        return;
      }
      soundRef.current = sound;
    } catch (e) {
      console.warn('Audio error', e?.message || e);
    }
  }, []);

  const playAtIndex = useCallback((idx) => {
    if (!tracks[idx]) return;
    currentIndexRef.current = idx;
    playItem(tracks[idx], idx);
  }, [tracks, playItem]);

  // Autoplay first track + prefetch a few covers
  useEffect(() => {
    if (!tracks.length) return;
    const t = setTimeout(() => playAtIndex(0), 120);
    tracks.slice(0, 8).forEach(tk => tk?.albumArtUrl && Image.prefetch(tk.albumArtUrl));
    return () => clearTimeout(t);
  }, [tracks, playAtIndex]);

  // Stop audio on app background / back press / unmount
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s !== 'active' && soundRef.current) { try { await soundRef.current.stopAsync(); } catch {} }
    });
    return () => sub.remove();
  }, []);
  useEffect(() => () => { if (soundRef.current) { soundRef.current.unloadAsync(); soundRef.current = null; } }, []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (soundRef.current) { try { soundRef.current.stopAsync(); } catch {} }
      return false;
    });
    return () => sub.remove();
  }, []);

  // Buttons (toggle)
  const toggleLike = useCallback((item) => {
    const id = item.id;
    setReaction(id, likesRef.current.has(id) ? null : 'like', item);
  }, [setReaction]);
  const toggleDislike = useCallback((item) => {
    const id = item.id;
    setReaction(id, dislikesRef.current.has(id) ? null : 'dislike', item);
  }, [setReaction]);

  // Vertical scroll finished -> switch playback
  const handleMomentumEnd = useCallback((e) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const idx = Math.max(0, Math.min(tracks.length - 1, Math.round(y / height)));
    tracks.slice(idx + 1, idx + 4).forEach(tk => tk?.albumArtUrl && Image.prefetch(tk.albumArtUrl));
    if (idx !== currentIndexRef.current) playAtIndex(idx);
  }, [tracks, playAtIndex]);

  const onViewableItemsChanged = useRef(() => {});
  const viewabilityConfig = useMemo(
    () => ({ itemVisiblePercentThreshold: 80, minimumViewTime: 60 }),
    []
  );

  // Infinite-ish load
  const loadMore = useCallback(async () => {
    try {
      const batch = await fetchTracks({ genreId, limit: PAGE * 3 });
      const seen = new Set(tracks.map(t => `${t.title}|${t.artist}|${t.album}`.toLowerCase()));
      const fresh = batch.filter(t => !seen.has(`${t.title}|${t.artist}|${t.album}`.toLowerCase()));
      const all = [...tracks, ...fresh];
      const idToArtist = new Map(all.map(x => [String(x.id), (x.artist || '').trim().toLowerCase()]));
      const likedArtists = new Set([...likesRef.current].map(id => idToArtist.get(String(id))).filter(Boolean));
      const dislikedArtists = new Set([...dislikesRef.current].map(id => idToArtist.get(String(id))).filter(Boolean));
      const diversified = biasAndDiversify(fresh, { likedArtists, dislikedArtists, target: PAGE });
      if (diversified.length) setTracks(prev => [...prev, ...diversified]);
    } catch (e) {
      console.warn('loadMore error', e);
    }
  }, [tracks, genreId]);

  const openBuy = useCallback(async (url) => { if (url) { try { await WebBrowser.openBrowserAsync(url); } catch {} } }, []);

  // Jump to a liked track from the Liked list: scroll + play (inject if missing)
  const jumpToTrack = useCallback((item) => {
    const idStr = String(item.id);
    setLikedModal(false);

    let idx = tracks.findIndex(t => String(t.id) === idStr);

    if (idx === -1) {
      const next = [item, ...tracks];
      setTracks(next);
      currentIndexRef.current = 0;
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
        playItem(item, 0);
      });
    } else {
      currentIndexRef.current = idx;
      listRef.current?.scrollToOffset({ offset: height * idx, animated: true });
      playItem(tracks[idx], idx);
    }
  }, [tracks, playItem]);

  // --------- UI helpers ---------
  const filteredGenres = useMemo(() => {
    const q = genreQuery.trim().toLowerCase();
    if (!q) return genres.slice(0, 200);
    const starts = [], includes = [];
    for (const g of genres) {
      const label = (g.label || g.name || '').toLowerCase();
      if (!label) continue;
      if (label.startsWith(q)) starts.push(g);
      else if (label.includes(q)) includes.push(g);
    }
    return [...starts, ...includes].slice(0, 200);
  }, [genres, genreQuery]);

  const likedArray = useMemo(() => Object.values(likedItems), [likedItems]);

  // --------- Render item ---------
  const renderItem = ({ item }) => {
    const liked = likes.has(item.id);
    const disliked = dislikes.has(item.id);

    return (
      <View style={styles.card}>
        {/* Top row: Genre + Liked list */}
        <View style={styles.overlayTopRow}>
          <TouchableOpacity style={styles.genrePill} onPress={() => setGenreModal(true)} activeOpacity={0.85}>
            <Text style={styles.genreText}>Genre ▾</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.likesPill} onPress={() => setLikedModal(true)} activeOpacity={0.85}>
            <FontAwesome name="heart" size={14} color="#f472b6" />
            <Text style={styles.likesText}>&nbsp;Liked&nbsp;({likedArray.length})</Text>
          </TouchableOpacity>
        </View>

        {/* Center: cover above mid + text under it */}
        <View style={{ alignItems: 'center', marginTop: COVER_TOP_OFFSET, paddingHorizontal: 16 }}>
          <PanGestureHandler
            onGestureEvent={onPanGestureEvent}
            onHandlerStateChange={onPanStateChange}
            activeOffsetX={[-18, 18]}   // need ~18px horizontal to trigger
            failOffsetY={[-14, 14]}     // cancel if vertical intent
          >
            <Animated.View>
              <Image source={{ uri: item.albumArtUrl }} style={styles.cover} resizeMode="contain" />
            </Animated.View>
          </PanGestureHandler>

          <View style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
            <Text style={styles.sub} numberOfLines={2}>{item.artist} • {item.album}</Text>
          </View>
        </View>

        {/* Gesture feedback icons */}
        <Animated.View pointerEvents="none" style={styles.feedbackWrap}>
          <Animated.View style={[styles.feedbackIcon, { left: width * 0.6 - 40, opacity: likeOpacity, transform: [{ scale: likeScale }] }]}>
            <FontAwesome name="thumbs-up" size={80} color="#22c55e" />
          </Animated.View>
          <Animated.View style={[styles.feedbackIcon, { left: width * 0.4 - 40, opacity: dislikeOpacity, transform: [{ scale: dislikeScale }] }]}>
            <FontAwesome name="thumbs-down" size={80} color="#ef4444" />
          </Animated.View>
        </Animated.View>

        {/* Bottom buttons */}
        <View style={styles.bottomArea}>
          <View style={styles.rowBetween}>
            <TouchableOpacity
              style={[styles.btn, disliked && styles.btnOn, styles.btnDislike]}
              onPress={() => toggleDislike(item)}
              activeOpacity={0.9}
            >
              <Text style={styles.btnText}>Dislike</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, liked && styles.btnOn, styles.btnLike]}
              onPress={() => toggleLike(item)}
              activeOpacity={0.9}
            >
              <Text style={styles.btnText}>Like</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.buyBtn} onPress={() => openBuy(item.storeUrl)} activeOpacity={0.9}>
              <Text style={styles.buyText}>Request to buy</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  // --------- Render root ---------
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      {loading && tracks.length === 0 ? (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#d1d5db', marginTop: 12 }}>Loading…</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={tracks}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          removeClippedSubviews
          initialNumToRender={4}
          windowSize={7}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          onViewableItemsChanged={onViewableItemsChanged.current}
          viewabilityConfig={viewabilityConfig}
          onEndReachedThreshold={0.5}
          onEndReached={loadMore}
          onMomentumScrollEnd={handleMomentumEnd}
          scrollEventThrottle={16}
        />
      )}

      {/* Genre modal */}
      <Modal visible={genreModal} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pick a genre</Text>
              <Pressable onPress={() => setGenreModal(false)}><Text style={styles.modalClose}>✕</Text></Pressable>
            </View>
            <TextInput
              placeholder="Search genres… e.g. rock, pop, metal"
              placeholderTextColor="#9ca3af"
              value={genreQuery}
              onChangeText={setGenreQuery}
              style={styles.search}
            />
            <FlatList
              data={filteredGenres}
              keyExtractor={(g) => String(g.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.genreRow}
                  onPress={() => { setGenreId(Number(item.id)); setGenreModal(false); setTracks([]); }}
                >
                  <Text style={styles.genreRowText} numberOfLines={1}>{item.label || item.name}</Text>
                </TouchableOpacity>
              )}
              keyboardShouldPersistTaps="handled"
            />
          </View>
        </View>
      </Modal>

      {/* Liked list modal */}
      <Modal visible={likedModal} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Liked songs</Text>
              <Pressable onPress={() => setLikedModal(false)}><Text style={styles.modalClose}>✕</Text></Pressable>
            </View>

            {likedArray.length === 0 ? (
              <View style={{ padding: 16 }}>
                <Text style={{ color: '#9ca3af' }}>No liked songs yet. Swipe right or tap Like.</Text>
              </View>
            ) : (
              <FlatList
                data={likedArray}
                keyExtractor={(it) => String(it.id)}
                renderItem={({ item }) => (
                  <View style={styles.likedRow}>
                    <Image source={{ uri: item.albumArtUrl }} style={styles.likedThumb} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.likedTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={styles.likedSub} numberOfLines={1}>{item.artist} • {item.album}</Text>
                    </View>
                    <TouchableOpacity onPress={() => jumpToTrack(item)}>
                      <Text style={styles.openLink}>Play</Text>
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}

const BTN_W = Math.min(160, width * 0.42);

const styles = StyleSheet.create({
  card: { height, width },
  cover: { width: COVER_SIZE, height: COVER_SIZE, backgroundColor: '#000', borderRadius: 10 },
  bottomArea: { position: 'absolute', left: 16, right: 16, bottom: 110 },

  overlayTopRow: {
    position: 'absolute', top: 40, left: 16, right: 16,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'
  },
  genrePill: { backgroundColor: '#111827', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: '#374151' },
  genreText: { color: '#e5e7eb', fontWeight: '600' },

  likesPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111827', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: '#374151' },
  likesText: { color: '#f9a8d4', fontWeight: '700' },

  title: { color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  sub: { color: '#e5e7eb', marginTop: 4, fontSize: 14, textAlign: 'center' },

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowCenter: { marginTop: 10, alignItems: 'center' },

  btn: {
    backgroundColor: '#111827',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    width: BTN_W,
    alignItems: 'center',
  },
  btnOn: { backgroundColor: '#2563eb22', borderColor: '#2563eb' },
  btnDislike: { alignSelf: 'flex-start' },
  btnLike: { alignSelf: 'flex-end' },
  btnText: { color: '#fff', fontWeight: '600' },

  buyBtn: { backgroundColor: '#1f2937', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: '#4b5563' },
  buyText: { color: '#a7f3d0', fontWeight: '700' },

  feedbackWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  feedbackIcon: { position: 'absolute', top: height * 0.35 },

  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  modalWrap: { flex: 1, backgroundColor: '#000000aa', padding: 16, paddingTop: 60 },
  modalCard: { flex: 1, backgroundColor: '#0b0f17', borderRadius: 16, borderWidth: 1, borderColor: '#1f2937', padding: 12 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  modalClose: { color: '#9ca3af', fontSize: 20, paddingHorizontal: 8 },
  search: { backgroundColor: '#0f172a', color: '#e5e7eb', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#334155', marginBottom: 8 },
  genreRow: { paddingVertical: 10, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1f2937' },
  genreRowText: { color: '#e5e7eb', fontSize: 14 },

  likedRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1f2937' },
  likedThumb: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#0b0f17' },
  likedTitle: { color: '#fff', fontWeight: '700' },
  likedSub: { color: '#9ca3af', marginTop: 2 },
  openLink: { color: '#60a5fa', fontWeight: '700' },
});
