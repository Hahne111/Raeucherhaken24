# Designvorlage ablegen

Damit die Startseite pixelgenau nach der Vorlage gebaut werden kann, wird das
Referenzbild als Datei im Projekt gebraucht – aus einem Chatbild allein lässt
es sich nicht erzeugen.

## So geht es

1. Das Referenzbild unter **`design/referenz.png`** ablegen
   (PNG oder JPG, am besten in Originalgröße 1672 × 941 Pixel).
2. Committen und pushen:

   ```bash
   mkdir -p design
   # Bild nach design/referenz.png kopieren
   git add design/referenz.png
   git commit -m "Designvorlage ergänzt"
   git push
   ```

3. In GitHub genügt auch: Ordner `design` anlegen, Datei hochladen, committen.

Danach kann die Vorlage direkt ausgemessen und als Bildquelle genutzt werden.
Der Ordner `design/` wird nicht ausgeliefert – er liegt außerhalb von `public/`
und ist damit über den Shop nicht erreichbar. Aus der Vorlage geschnittene
Einzelmotive landen als optimierte Dateien in `public/img/`.

Diese Datei kann gelöscht werden, sobald das Bild im Projekt liegt.
