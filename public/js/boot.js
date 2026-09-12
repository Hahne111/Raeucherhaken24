/* Markiert aktives JavaScript, bevor die Seite gezeichnet wird.
   Nur dann werden Inhalte für die Einblendung zunächst versteckt –
   ohne JavaScript bleibt alles sofort sichtbar. */
document.documentElement.classList.add('js');
