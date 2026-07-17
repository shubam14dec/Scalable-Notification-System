import { useEffect, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePushRegistration, type PushMessage } from '@asyncify-hq/react-native';

const STORE_API_URL = 'asyncify.apiUrl';
const STORE_TOKEN = 'asyncify.token';

type LogEntry = { at: string; text: string };

export default function App() {
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);

  // Restore the two inputs on launch so a rebuild/reopen keeps them.
  useEffect(() => {
    AsyncStorage.multiGet([STORE_API_URL, STORE_TOKEN])
      .then((pairs) => {
        for (const [k, v] of pairs) {
          if (v == null) continue;
          if (k === STORE_API_URL) setApiUrl(v);
          if (k === STORE_TOKEN) setToken(v);
        }
      })
      .catch(() => undefined);
  }, []);

  const push = usePushRegistration({
    token,
    apiUrl,
    onForegroundMessage: (msg: PushMessage) => {
      const text = `${msg.title ?? '(no title)'} — ${msg.body ?? ''}`.trim();
      setLog((prev) => [{ at: new Date().toLocaleTimeString(), text }, ...prev].slice(0, 50));
    },
  });

  async function onEnable() {
    // Persist first so the values survive the permission dialog / a crash.
    await AsyncStorage.multiSet([
      [STORE_API_URL, apiUrl],
      [STORE_TOKEN, token],
    ]).catch(() => undefined);
    await push.enable();
  }

  const canEnable = apiUrl.trim().length > 0 && token.trim().length > 0 && !push.busy;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Asyncify Push Test</Text>
        <Text style={styles.subtitle}>Register this device for native push.</Text>

        <Text style={styles.label}>API URL</Text>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="https://your-tunnel.trycloudflare.com"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.hint}>
          Must be reachable from the phone — a LAN IP or tunnel, never localhost.
        </Text>

        <Text style={styles.label}>Subscriber token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="nst_..."
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TouchableOpacity
          style={[styles.button, !canEnable && styles.buttonDisabled]}
          onPress={onEnable}
          disabled={!canEnable}
        >
          <Text style={styles.buttonText}>
            {push.busy ? 'Working…' : push.enabled ? 'Re-register' : 'Enable Push'}
          </Text>
        </TouchableOpacity>

        {push.enabled && (
          <TouchableOpacity
            style={[styles.button, styles.buttonGhost]}
            onPress={push.disable}
            disabled={push.busy}
          >
            <Text style={[styles.buttonText, styles.buttonGhostText]}>Disable Push</Text>
          </TouchableOpacity>
        )}

        <View style={styles.status}>
          <StatusRow k="supported" v={String(push.supported)} />
          <StatusRow k="permission" v={push.permission} />
          <StatusRow k="enabled" v={String(push.enabled)} />
          {push.error && <StatusRow k="error" v={push.error} bad />}
        </View>

        <Text style={styles.label}>Foreground messages</Text>
        <View style={styles.logBox}>
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>
              None yet. Background/closed notifications are shown by the OS and
              won't appear here — only messages arriving while this app is open.
            </Text>
          ) : (
            log.map((e, i) => (
              <Text key={`${e.at}-${i}`} style={styles.logLine}>
                <Text style={styles.logTime}>{e.at}</Text> {e.text}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function StatusRow({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusKey}>{k}</Text>
      <Text style={[styles.statusVal, bad && styles.statusBad]}>{v}</Text>
    </View>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0a' },
  body: { padding: 20, paddingTop: 64, gap: 8 },
  title: { color: '#ededed', fontSize: 22, fontWeight: '600' },
  subtitle: { color: '#a1a1a1', fontSize: 13, marginBottom: 16 },
  label: { color: '#a1a1a1', fontSize: 12, marginTop: 12, marginBottom: 4 },
  hint: { color: '#666', fontSize: 11, marginTop: 4 },
  input: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ededed',
    fontFamily: mono,
    fontSize: 13,
  },
  button: {
    backgroundColor: '#ededed',
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: { backgroundColor: '#333' },
  buttonText: { color: '#0a0a0a', fontWeight: '600', fontSize: 14 },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginTop: 10,
  },
  buttonGhostText: { color: '#ededed' },
  status: {
    marginTop: 20,
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  statusKey: { color: '#a1a1a1', fontSize: 12, fontFamily: mono },
  statusVal: { color: '#ededed', fontSize: 12, fontFamily: mono },
  statusBad: { color: '#f87171' },
  logBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 80,
  },
  logEmpty: { color: '#666', fontSize: 12, lineHeight: 18 },
  logLine: { color: '#ededed', fontSize: 12, fontFamily: mono, paddingVertical: 2 },
  logTime: { color: '#666' },
});
