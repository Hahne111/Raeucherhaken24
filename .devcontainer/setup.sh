#!/usr/bin/env bash
# Einrichtung des Codespace: Pakete, Umgebung, Grunddaten.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Node $(node -v)"
npm install

# .env wird nicht committet. Das Sitzungsgeheimnis entsteht hier im Codespace,
# damit eine Anmeldung einen Neustart des Servers übersteht.
if [ ! -f .env ]; then
  {
    echo "PORT=3000"
    echo "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
    # Codespaces reicht den Port über einen Proxy weiter.
    echo "TRUST_PROXY=1"
    # Bewusst aus: die Portweiterleitung läuft im Browser über HTTPS, in
    # VS Code Desktop aber über http://localhost. Mit Secure-Cookies würde
    # die Anmeldung dort kommentarlos scheitern. Auf einem echten Server
    # mit HTTPS gehört hier eine 1 hin.
    echo "SECURE_COOKIES=0"
  } > .env
  echo "→ .env angelegt (bleibt im Codespace, wird nicht committet)"
fi

# Grunddaten nur beim ersten Mal; eine vorhandene Datenbank bleibt unberührt.
if [ ! -f data/shop.db ]; then
  npm run seed
fi

cat <<'HINT'

Fertig. So geht es weiter:

  npm start            Server auf Port 3000 starten
  npm run dev          dasselbe, startet bei Dateiänderungen neu

Codespaces öffnet den Port automatisch. Beim ersten Aufruf von
/verwaltung wirst du auf /verwaltung/einrichten geleitet und legst dort
deinen eigenen Admin-Zugang an – es gibt kein Passwort im Repository.

  npm run test:alle    alle Prüfskripte

HINT
