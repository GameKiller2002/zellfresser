# Zellfresser Online

Mehrspieler-Spiel im Stil von Agar.io. Der Server berechnet die gemeinsame Arena (Bewegung, Fressen, Futter, Viren, Bots), der Browser zeigt sie an. Wenn wenige Spieler da sind, füllen Bots die Arena auf. Der Skin-Shop und die Münzen bleiben im Browser des jeweiligen Spielers gespeichert.

## Inhalt

- `server.js` – der Spiel-Server (Node.js, braucht das Paket `ws`)
- `package.json` – Abhängigkeiten und Startbefehl
- `public/index.html` – das Spiel im Browser
- `public/config.js` – Adresse des Servers (nur nötig, wenn die Seite woanders liegt)

## 1. Zuerst lokal ausprobieren

1. Installiere Node.js (Version 18 oder neuer) von nodejs.org.
2. Öffne ein Terminal im Ordner `zellfresser-server` und führe aus:
   ```
   npm install
   npm start
   ```
3. Öffne http://localhost:3000 im Browser, wähle "Online" und starte.
4. Andere Geräte im selben WLAN öffnen `http://DEINE-IP:3000` (die IP deines Rechners im Netzwerk).

## 2. Kostenlos ins Internet (Render)

1. Lege ein kostenloses Konto bei github.com an und erstelle ein neues Repository.
2. Lade den Inhalt von `zellfresser-server` hoch (`server.js`, `package.json`, den Ordner `public` und diese Datei). Den Ordner `node_modules` brauchst du nicht.
3. Lege ein kostenloses Konto bei render.com an und wähle New, dann Web Service. Verbinde dein GitHub-Repository.
4. Trage ein:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
5. Klicke auf Deploy. Nach einigen Minuten steht oben eine Adresse wie `https://zellfresser.onrender.com`. Diese Adresse öffnet das Spiel, jeder kann sie aufrufen.

Hinweis zum kostenlosen Plan: Der Server schläft nach einiger Zeit ohne Besucher ein. Der erste Spieler wartet dann bis zu einer Minute, das Spiel zeigt dabei eine Meldung an. Die Bedingungen des Anbieters können sich ändern, prüfe sie vor der Anmeldung.

## 3. Seite bei Netlify, Server bei Render (optional)

Du brauchst Netlify nicht, wenn du die Render-Adresse nutzt. Willst du die Seite trotzdem bei Netlify halten:

1. Öffne `public/config.js` und trage die Adresse deines Servers mit `wss://` ein:
   ```
   window.ZF_CONFIG = { server: "wss://zellfresser.onrender.com" };
   ```
2. Ziehe den Ordner `public` auf app.netlify.com/drop.
3. Empfohlen: Setze bei Render die Umgebungsvariable `ALLOWED_ORIGINS` auf die Netlify-Adresse (zum Beispiel `https://meinspiel.netlify.app`), damit nur deine Seite den Server nutzen kann.

## Einstellungen (Umgebungsvariablen)

| Name | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | Port des Servers (Render setzt ihn selbst) |
| `TOTAL_PLAYERS` | 24 | Spieler und Bots zusammen. Je mehr echte Spieler, desto weniger Bots |
| `MIN_BOTS` | 6 | So viele Bots bleiben immer in der Arena |
| `MAX_HUMANS` | 40 | Höchstzahl echter Spieler |
| `ALLOWED_ORIGINS` | leer | Kommagetrennte Liste erlaubter Seiten-Adressen. Leer erlaubt alle |

## Gut zu wissen

- Auf dem kostenlosen Plan sind etwa 10 bis 20 gleichzeitige Spieler realistisch. Danach kann es ruckeln.
- Die Arena pausiert, solange kein Spieler verbunden ist.
- Skins und Münzen werden im Browser gespeichert. Der Server prüft nicht, ob ein Skin gekauft wurde.
- Namen werden gekürzt und von Steuerzeichen befreit. Zur Kontrolle von Beleidigungen gibt es keinen Filter.
