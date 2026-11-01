/* Daten kommen aus data/*.js: BETREIBER (Liste), GEMEINDEN, GEBIETE, KREISE, LAENDER (GeoJSON), META */
(function () {
  "use strict";

  const PALETTE = ["#f2c500", "#e8743b", "#3f9fd6", "#6bb84a", "#a56cc1", "#e36f9f", "#34b3a0", "#9aa7ad", "#c9a14a", "#6f7fd6"];
  const touch = window.matchMedia("(hover: none)").matches;

  // trackResize aus: Groessenaenderungen behandelt der ResizeObserver weiter unten
  const map = L.map("map", { preferCanvas: true, minZoom: 5, maxZoom: 14, zoomControl: false, zoomSnap: 0.5, trackResize: false });
  if (!touch) L.control.zoom({ position: "bottomright" }).addTo(map);
  const DEUTSCHLAND = [[47.2, 5.8], [55.1, 15.1]];
  map.fitBounds(DEUTSCHLAND);
  let moved = false;
  // Nur solange niemand die Karte bewegt hat, passt sie sich bei Groessenaenderungen wieder an Deutschland an
  let selbstAngepasst = false;
  map.on("movestart zoomstart", () => { if (!selbstAngepasst) moved = true; });
  new ResizeObserver(() => {
    selbstAngepasst = true;
    map.invalidateSize({ animate: false });
    if (!moved) map.fitBounds(DEUTSCHLAND, { animate: false });
    selbstAngepasst = false;
  }).observe(document.getElementById("map"));
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap-Mitwirkende</a> | MaStR &copy; Bundesnetzagentur dl-de/by-2-0, bearbeitet | &copy; EuroGeographics bezüglich der Verwaltungsgrenzen',
  }).addTo(map);

  const SATELLIT_JAHR = META.satJahr;
  const SATELLIT_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${SATELLIT_JAHR}_3857/default/g/{z}/{y}/{x}.jpg`;
  const satellit = L.tileLayer(SATELLIT_URL, {
    maxZoom: 14, zIndex: 2,
    attribution: `<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${SATELLIT_JAHR})`,
  });

  map.createPane("netz").style.zIndex = 400;
  map.createPane("grenzen").style.zIndex = 420;
  map.createPane("highlight").style.zIndex = 430;
  map.getPane("grenzen").style.pointerEvents = "none";
  map.getPane("highlight").style.pointerEvents = "none";
  // Satellitenbild nur innerhalb des fixierten Gebiets: eigene Ebene ueber den Farben, per clip-path zugeschnitten
  const ausschnittPane = map.createPane("satAusschnitt");
  ausschnittPane.style.zIndex = 405;
  ausschnittPane.style.pointerEvents = "none";
  const satAusschnitt = L.tileLayer(SATELLIT_URL, {
    pane: "satAusschnitt", maxZoom: 14, updateWhenZooming: false, attribution: satellit.options.attribution,
  });

  const canvas = L.canvas({ pane: "netz", padding: 0.2, tolerance: touch ? 4 : 0 });
  const borderCanvas = L.canvas({ pane: "grenzen", padding: 0.2 });
  const highlightCanvas = L.canvas({ pane: "highlight", padding: 0.2 });

  const card = document.getElementById("card");
  let opacity = 0.5;
  let pinned = null;
  let hovered = null;
  let highlight = null;
  let highlightB = null;
  let hideTimer = null;
  let kreisLayer = null;
  let kreisFeature = null;
  let ausschnitt = null;

  const gebietById = new Map();
  GEBIETE.features.forEach((f) => gebietById.set(f.properties.b, f));

  const style = (f) => ({ pane: "netz", renderer: canvas, stroke: false, fillOpacity: opacity, fillColor: PALETTE[BETREIBER[f.properties.b].farbe] });

  const netz = L.geoJSON(GEMEINDEN, { style, onEachFeature: (f, layer) => {
    layer.on({
      mouseover: () => { if (!touch && !pinned) show(f); },
      // Kurze Verzoegerung, damit der Wechsel zwischen Gemeinden desselben Betreibers nicht flackert
      mouseout: () => {
        if (touch || pinned) return;
        hideTimer = setTimeout(() => { if (!pinned) { hovered = null; clearHighlight(); card.hidden = true; } }, 40);
      },
      click: (e) => { e.originalEvent.netzTreffer = true; clearSuche(); pinned = f; hovered = null; show(f); },
    });
  } }).addTo(map);

  const operatorBorders = L.geoJSON(GEBIETE, { interactive: false, style: { pane: "grenzen", renderer: borderCanvas, color: "#17242b", weight: 0.7, opacity: 0.55, fill: false } }).addTo(map);

  const kreise = L.geoJSON(KREISE, {
    interactive: false,
    style: { pane: "grenzen", renderer: borderCanvas, color: "#17242b", weight: 1, dashArray: "3 3", opacity: 0.75, fill: false },
  });
  const kreisLabels = L.layerGroup(KREISE.features.filter((f) => f.properties.n).map((f) =>
    L.tooltip({ permanent: true, direction: "center", className: "kreis-label", interactive: false }).setLatLng([f.properties.lat, f.properties.lon]).setContent(esc(f.properties.n))));

  const laender = L.geoJSON(LAENDER, {
    interactive: false,
    style: { pane: "grenzen", renderer: borderCanvas, color: "#17242b", weight: 2, opacity: 0.85, fill: false },
  }).addTo(map);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function link(url, label) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url; }
  }
  function row(label, value) {
    return value ? `<dt>${label}</dt><dd>${value}</dd>` : "";
  }

  function clearHighlight() {
    if (highlight) { map.removeLayer(highlight); highlight = null; }
    highlightB = null;
  }

  // Weit herausgezoomt liegen viele Grenzen dicht beieinander, die Linie wird deshalb mit dem Zoom kraeftiger
  function strichStaerke() {
    return Math.min(3, Math.max(1, 1 + (map.getZoom() - 5) * 0.4));
  }
  // Weisser Saum unter der roten Linie, damit sie auch auf roten und orangen Flaechen sichtbar bleibt
  function roteLinie(geojson) {
    const w = strichStaerke();
    const saum = L.geoJSON(geojson, { interactive: false, style: { pane: "highlight", renderer: highlightCanvas, color: "#ffffff", weight: w + 1.5, opacity: 0.8, fill: false } });
    const rot = L.geoJSON(geojson, { interactive: false, style: { pane: "highlight", renderer: highlightCanvas, color: "#e00000", weight: w, opacity: 1, fill: false } });
    const gruppe = L.layerGroup([saum, rot]);
    gruppe.saum = saum;
    gruppe.rot = rot;
    return gruppe;
  }
  map.on("zoomend", () => {
    const w = strichStaerke();
    [highlight, kreisLayer].forEach((g) => {
      if (!g) return;
      g.saum.setStyle({ weight: w + 1.5 });
      g.rot.setStyle({ weight: w });
    });
  });

  function setHighlight(b) {
    if (highlightB === b) return;
    clearHighlight();
    const gebiet = gebietById.get(b);
    if (!gebiet) return;
    highlight = roteLinie(gebiet).addTo(map);
    highlightB = b;
  }

  function zeichneAusschnitt() {
    if (!ausschnitt) return;
    const flaechen = ausschnitt.type === "Polygon" ? [ausschnitt.coordinates] : ausschnitt.coordinates;
    const teile = [];
    for (const flaeche of flaechen) {
      for (const ring of flaeche) {
        ring.forEach((c, i) => {
          const p = map.latLngToLayerPoint([c[1], c[0]]);
          teile.push(`${i ? "L" : "M"}${Math.round(p.x)} ${Math.round(p.y)}`);
        });
        teile.push("Z");
      }
    }
    ausschnittPane.style.clipPath = `path(evenodd, "${teile.join("")}")`;
    ausschnittPane.style.visibility = "visible";
  }
  function setzeAusschnitt() {
    const gebiet = kreisFeature || gebietById.get(highlightB);
    ausschnitt = gebiet ? gebiet.geometry : null;
    if (!ausschnitt) { entferneAusschnitt(); return; }
    if (!map.hasLayer(satAusschnitt)) satAusschnitt.addTo(map);
    zeichneAusschnitt();
  }
  function entferneAusschnitt() {
    ausschnitt = null;
    if (map.hasLayer(satAusschnitt)) map.removeLayer(satAusschnitt);
    ausschnittPane.style.clipPath = "";
  }
  // Der Zuschnitt gilt fuer genau eine Zoomstufe und waere waehrend der Zoom-Animation verschoben
  map.on("zoomstart", () => { if (ausschnitt) ausschnittPane.style.visibility = "hidden"; });
  map.on("zoomend viewreset", zeichneAusschnitt);

  function betreiberHtml(b) {
    let contact = "";
    if (b.portal) contact = link(b.portal, "Netzanschlussportal öffnen");
    else if (b.seite) contact = link(b.seite, "Netzanschluss-Seite öffnen");
    const mail = b.mail ? `${esc(b.mail)}${b.mailArt ? ' <span style="color:var(--muted)">(allgemein)</span>' : ""}` : "";
    return `
      <h2>${esc(b.name)}</h2>
      ${b.mutter ? `<div class="parent">Muttergesellschaft: ${esc(b.mutter)}${b.mutterUngeprueft ? " (ungeprüft)" : ""}</div>` : ""}
      <dl>
        ${row("Sitz", esc(b.adresse))}
        ${row("Website", b.impressum ? link(b.impressum, "Impressum") : b.web ? link(b.web, hostOf(b.web)) : "")}
        ${row("Netzanschluss", contact)}
        ${row("E-Mail", mail)}
        ${row("Telefon", b.tel ? esc(b.tel) : "")}
      </dl>`;
  }

  function zeigeKarte(inhalt) {
    card.innerHTML = `
      ${pinned ? '<button id="close" type="button" aria-label="Schließen">×</button>' : ""}
      ${inhalt}
      <div id="about">Gebiete abgeleitet aus dem Marktstammdatenregister, Stand ${esc(META.stand)}. Nicht adressgenau.</div>`;
    card.hidden = false;
    card.classList.toggle("pinned", !!pinned);
    card.scrollTop = 0;
    const close = document.getElementById("close");
    if (close) close.addEventListener("click", unpin);
    if (pinned) setzeAusschnitt();
  }

  function show(f, adresse) {
    const p = f.properties;
    const b = BETREIBER[p.b];
    clearTimeout(hideTimer);
    if (hovered === f && !card.hidden && !pinned) return;
    hovered = f;
    setHighlight(p.b);

    let notes = "";
    if (p.g) notes += `<div class="note">Für diese Gemeinde liegen keine Anlagendaten vor. Der Betreiber ist vom Nachbargebiet übernommen.</div>`;
    else if (p.a < 70) notes += `<div class="note">Grenzgebiet: Nur ${p.a} % der Anlagen liegen bei diesem Betreiber. Bitte die Adresse direkt prüfen.</div>`;
    else if (p.a < 95) notes += `<div class="note">Mehrere Betreiber möglich: ${p.a} % der Anlagen liegen bei diesem Betreiber.</div>`;
    const auch = (p.w || []).map((w) => `${esc(BETREIBER[w[0]].name)} (${w[1]} %)`).join(", ");

    zeigeKarte(`
      ${betreiberHtml(b)}
      <div class="place">
        ${adresse ? `<div class="adresse-zeile">${esc(adresse)}</div>` : ""}
        <strong>${esc(p.n)}</strong>${p.k ? ` · ${esc(p.k)}` : ""}
        ${auch ? `<div>Auch vertreten: ${auch}</div>` : ""}
        ${notes}
      </div>
      ${!pinned && !touch ? '<div class="hint">Klicken, um das Fenster offen zu halten und Links zu nutzen.</div>' : ""}`);
  }

  function unpin() {
    pinned = null;
    hovered = null;
    clearSuche();
    clearHighlight();
    card.hidden = true;
    card.classList.remove("pinned");
  }
  // Canvas-Klicks erreichen auch die Karte; nur Klicks ausserhalb der Gebiete schliessen das Fenster.
  // Bei niedrigem Zoom entstehen beim Zeichnen duenne Luecken zwischen Gemeinden, dort zaehlt die echte Geometrie.
  map.on("click", (e) => {
    if (e.originalEvent.netzTreffer) return;
    const f = map.hasLayer(netz) ? findeGemeinde(e.latlng.lat, e.latlng.lng) : null;
    if (!f) { unpin(); return; }
    clearSuche();
    pinned = f;
    hovered = null;
    show(f);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") unpin(); });

  function toggle(id, layers) {
    document.getElementById(id).addEventListener("change", (e) => {
      layers.forEach((l) => (e.target.checked ? l.addTo(map) : map.removeLayer(l)));
      updateLabels();
      if (!e.target.checked && id === "l-netz") unpin();
    });
  }
  toggle("l-netz", [netz, operatorBorders]);
  toggle("l-land", [laender]);
  toggle("l-kreis", [kreise]);
  toggle("l-sat", [satellit]);

  function updateLabels() {
    const on = document.getElementById("l-kreis").checked && map.getZoom() >= 8;
    if (on && !map.hasLayer(kreisLabels)) kreisLabels.addTo(map);
    if (!on && map.hasLayer(kreisLabels)) map.removeLayer(kreisLabels);
  }
  map.on("zoomend", updateLabels);

  document.getElementById("opacity").addEventListener("input", (e) => {
    opacity = e.target.value / 100;
    netz.setStyle(style);
  });
  const layersPanel = document.getElementById("layers");
  const toggleBtn = document.getElementById("toggle");
  toggleBtn.addEventListener("click", () => {
    const open = layersPanel.classList.toggle("open");
    toggleBtn.setAttribute("aria-expanded", open);
  });
  L.DomEvent.disableClickPropagation(layersPanel);
  L.DomEvent.disableClickPropagation(card);
  L.DomEvent.disableScrollPropagation(card);

  /* Suche: Betreiber, Kreise und Gemeinden lokal beim Tippen; Adressen nur auf Enter oder Klick,
     weil die Nominatim-Regeln Autovervollstaendigung und mehr als eine Anfrage pro Sekunde verbieten */
  const form = document.getElementById("suche");
  const feld = document.getElementById("q");
  const los = document.getElementById("los");
  const liste = document.getElementById("treffer");
  const meldung = document.getElementById("meldung");
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const PIN = L.divIcon({
    className: "pin", iconSize: [30, 40], iconAnchor: [15, 40],
    html: '<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 1C7.3 1 1 7.2 1 14.8 1 25 15 39 15 39s14-14 14-24.2C29 7.2 22.7 1 15 1z" fill="#e00000" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>',
  });
  const norm = (s) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const eintraege = [
    ...GEBIETE.features.map((f) => ({ typ: "betreiber", i: f.properties.b, name: BETREIBER[f.properties.b].name, info: `Netzbetreiber · ${BETREIBER[f.properties.b].adresse}` })),
    ...BETREIBER.map((b, i) => ({ typ: "betreiber", i, name: b.name, info: `Netzbetreiber · ${b.adresse}` })).filter((e) => !gebietById.has(e.i)),
    ...KREISE.features.map((f) => ({ typ: "kreis", f, name: f.properties.n, info: "Kreis" })),
    ...GEMEINDEN.features.map((f) => ({ typ: "gemeinde", f, name: f.properties.n, info: `Gemeinde · ${f.properties.k}` })),
  ].map((e) => ({ ...e, key: norm(e.name) }));
  const OBERGRENZE = { betreiber: 4, kreis: 3, gemeinde: 4 };

  let pin = null;
  let angezeigt = [];
  let aktiv = -1;
  let letzteAnfrage = 0;
  let zoomNachgeholt = null;
  const cache = new Map();

  function clearSuche() {
    if (pin) { map.removeLayer(pin); pin = null; }
    if (kreisLayer) { map.removeLayer(kreisLayer); kreisLayer = null; }
    kreisFeature = null;
    entferneAusschnitt();
  }
  function setzePin(lat, lon) {
    if (pin) map.removeLayer(pin);
    pin = L.marker([lat, lon], { icon: PIN, interactive: false, keyboard: false }).addTo(map);
  }
  function melde(text) {
    meldung.textContent = text || "";
    meldung.hidden = !text;
  }
  // Das Infofenster verdeckt am Handy die untere und am Desktop die linke Seite, das Ziel soll daneben liegen
  function zoomZu(grenzen, maxZoom) {
    moved = true;
    // Leaflet verwirft Zoomwuensche waehrend einer laufenden Animation
    map.off("zoomend", zoomNachgeholt);
    if (map._animatingZoom) {
      zoomNachgeholt = () => zoomZu(grenzen, maxZoom);
      map.once("zoomend", zoomNachgeholt);
      return;
    }
    const breit = window.innerWidth > 900 && !card.hidden;
    const unten = window.innerWidth <= 640 && !card.hidden ? card.offsetHeight : 0;
    map.fitBounds(grenzen, { maxZoom, paddingTopLeft: [breit ? card.offsetWidth + 30 : 20, 70], paddingBottomRight: [20, unten + 30] });
  }

  function ringe(geom) {
    return geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  }
  function imPolygon(geom, x, y) {
    let drin = false;
    for (const ring of ringe(geom)) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) drin = !drin;
      }
    }
    return drin;
  }
  function rahmen(f) {
    if (!f.rahmen) {
      let [x0, y0, x1, y1] = [180, 90, -180, -90];
      for (const ring of ringe(f.geometry)) for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      f.rahmen = [x0, y0, x1, y1];
    }
    return f.rahmen;
  }
  function findeGemeinde(lat, lon) {
    return GEMEINDEN.features.find((f) => {
      const [x0, y0, x1, y1] = rahmen(f);
      return lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && imPolygon(f.geometry, lon, lat);
    });
  }
  function innenpunkt(f) {
    const [x0, y0, x1, y1] = rahmen(f);
    for (const n of [2, 4, 8, 16]) {
      for (let a = 1; a < n; a += 1) for (let c = 1; c < n; c += 1) {
        const x = x0 + ((x1 - x0) * a) / n;
        const y = y0 + ((y1 - y0) * c) / n;
        if (imPolygon(f.geometry, x, y)) return [y, x];
      }
    }
    return [f.geometry.type === "Polygon" ? f.geometry.coordinates[0][0][1] : f.geometry.coordinates[0][0][0][1], f.geometry.type === "Polygon" ? f.geometry.coordinates[0][0][0] : f.geometry.coordinates[0][0][0][0]];
  }

  function neuesZiel() {
    clearSuche();
    clearHighlight();
    melde("");
    schliesseListe();
    pinned = "suche";
    hovered = null;
  }

  function zeigeGemeinde(f) {
    neuesZiel();
    const [lat, lon] = innenpunkt(f);
    pinned = f;
    show(f);
    setzePin(lat, lon);
    zoomZu(L.geoJSON(f).getBounds(), 12);
  }

  function zeigeKreis(f) {
    neuesZiel();
    const p = f.properties;
    kreisLayer = roteLinie(f).addTo(map);
    kreisFeature = f;
    setzePin(p.lat, p.lon);
    const zaehler = new Map();
    let gemeinden = 0;
    GEMEINDEN.features.forEach((g) => {
      if (g.properties.z === p.id) { gemeinden += 1; zaehler.set(g.properties.b, (zaehler.get(g.properties.b) || 0) + 1); }
    });
    const zeilen = [...zaehler.entries()].sort((a, c) => c[1] - a[1]).map(([b, n]) =>
      `<button type="button" data-b="${b}">${esc(BETREIBER[b].name)} (${n} ${n === 1 ? "Gemeinde" : "Gemeinden"})</button>`).join("");
    zeigeKarte(`<h2>${esc(p.n)}</h2><div class="parent">Kreis mit ${gemeinden} ${gemeinden === 1 ? "Gemeinde" : "Gemeinden"} und ${zaehler.size} ${zaehler.size === 1 ? "Netzbetreiber" : "Netzbetreibern"}</div><div class="kreis-liste">${zeilen}</div>`);
    zoomZu(L.geoJSON(f).getBounds(), 12);
  }

  function zeigeBetreiber(i) {
    neuesZiel();
    setHighlight(i);
    const gebiet = gebietById.get(i);
    const b = BETREIBER[i];
    let grenzen;
    let hinweis = "";
    if (gebiet) {
      grenzen = L.geoJSON(gebiet).getBounds();
    } else {
      // Betreiber ohne eigenes Gebiet ueberwiegen in keiner Gemeinde, sind aber in einzelnen vertreten
      const orte = GEMEINDEN.features.filter((g) => (g.properties.w || []).some((w) => w[0] === i));
      if (orte.length) grenzen = L.geoJSON({ type: "FeatureCollection", features: orte }).getBounds();
      hinweis = `<div class="place"><div class="note">Dieser Betreiber überwiegt in keiner Gemeinde und hat deshalb kein eigenes Gebiet auf der Karte. Vertreten in: ${orte.map((g) => esc(g.properties.n)).slice(0, 8).join(", ") || "nicht bekannt"}.</div></div>`;
    }
    zeigeKarte(betreiberHtml(b) + hinweis);
    if (grenzen) zoomZu(grenzen, 12);
    // Der Pin zeigt den Firmensitz, falls der Adressdienst ihn findet
    nominatim(`${b.adresse}`).then((r) => {
      if (r.length && pinned === "suche" && highlightB === i) setzePin(+r[0].lat, +r[0].lon);
    }).catch(() => {});
  }

  function zeigeAdresse(r) {
    const lat = +r.lat;
    const lon = +r.lon;
    const f = findeGemeinde(lat, lon);
    if (!f) {
      neuesZiel();
      pinned = null;
      melde("Diese Adresse liegt außerhalb der Gemeindegebiete der Karte.");
      setzePin(lat, lon);
      map.setView([lat, lon], 11);
      moved = true;
      return;
    }
    neuesZiel();
    pinned = f;
    show(f, r.display_name.replace(/, Deutschland$/, ""));
    setzePin(lat, lon);
    const d = 0.02;
    zoomZu([[lat - d, lon - d], [lat + d, lon + d]], 13);
  }

  async function nominatim(text) {
    const schluessel = norm(text);
    if (cache.has(schluessel)) return cache.get(schluessel);
    const warten = letzteAnfrage + 1100 - Date.now();
    letzteAnfrage = Math.max(Date.now(), letzteAnfrage + 1100);
    if (warten > 0) await new Promise((fertig) => setTimeout(fertig, warten));
    const url = `${NOMINATIM}?${new URLSearchParams({ q: text, format: "jsonv2", limit: "5", countrycodes: "de", "accept-language": "de" })}`;
    const antwort = await fetch(url);
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    const daten = await antwort.json();
    cache.set(schluessel, daten);
    return daten;
  }

  async function sucheAdresse(text) {
    schliesseListe();
    melde("");
    los.setAttribute("aria-busy", "true");
    try {
      const treffer = await nominatim(text);
      if (!treffer.length) {
        melde("Keine Adresse gefunden. Ergänze Ort oder Postleitzahl.");
        return;
      }
      const orte = treffer.filter((r, i) => treffer.findIndex((s) => Math.abs(s.lat - r.lat) < 0.01 && Math.abs(s.lon - r.lon) < 0.01) === i);
      if (orte.length === 1) {
        zeigeAdresse(orte[0]);
        feld.value = text;
      } else {
        zeigeListe(orte.map((r) => ({ typ: "adresse", r, name: r.display_name.replace(/, Deutschland$/, ""), info: "Adresse" })));
      }
    } catch (_) {
      melde("Der Adressdienst ist gerade nicht erreichbar. Bitte später erneut versuchen.");
    } finally {
      los.removeAttribute("aria-busy");
    }
  }

  function waehle(e) {
    feld.value = e.typ === "suche" ? e.text : e.name;
    if (e.typ === "suche") sucheAdresse(e.text);
    else if (e.typ === "adresse") zeigeAdresse(e.r);
    else if (e.typ === "betreiber") zeigeBetreiber(e.i);
    else if (e.typ === "kreis") zeigeKreis(e.f);
    else zeigeGemeinde(e.f);
  }

  function schliesseListe() {
    liste.hidden = true;
    liste.textContent = "";
    angezeigt = [];
    aktiv = -1;
  }
  function zeigeListe(eintrag) {
    angezeigt = eintrag;
    aktiv = -1;
    liste.textContent = "";
    eintrag.forEach((e) => {
      const knopf = document.createElement("button");
      knopf.type = "button";
      knopf.className = `treffer${e.typ === "suche" ? " adresse" : ""}`;
      knopf.textContent = e.name;
      const info = document.createElement("small");
      info.textContent = e.info;
      knopf.appendChild(info);
      knopf.addEventListener("click", () => waehle(e));
      liste.appendChild(knopf);
    });
    liste.hidden = !eintrag.length;
  }

  function vorschlaege() {
    const text = feld.value.trim();
    melde("");
    if (text.length < 2) { schliesseListe(); return; }
    const woerter = norm(text).split(" ");
    const treffer = eintraege.filter((e) => woerter.every((w) => e.key.includes(w)));
    treffer.sort((a, c) => Number(!a.key.startsWith(woerter[0])) - Number(!c.key.startsWith(woerter[0])) || a.name.length - c.name.length);
    const zaehler = {};
    const auswahl = treffer.filter((e) => { zaehler[e.typ] = (zaehler[e.typ] || 0) + 1; return zaehler[e.typ] <= OBERGRENZE[e.typ]; });
    zeigeListe([...auswahl, { typ: "suche", text, name: `„${text}“ als Adresse suchen`, info: "Über OpenStreetMap, die Eingabe wird dorthin gesendet" }]);
  }

  feld.addEventListener("input", vorschlaege);
  feld.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!liste.hidden) schliesseListe();
      else feld.value = "";
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && angezeigt.length) {
      e.preventDefault();
      aktiv = (aktiv + (e.key === "ArrowDown" ? 1 : -1) + angezeigt.length) % angezeigt.length;
      [...liste.children].forEach((k, i) => k.classList.toggle("aktiv", i === aktiv));
      liste.children[aktiv].scrollIntoView({ block: "nearest" });
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (los.getAttribute("aria-busy")) return;
    const text = feld.value.trim();
    if (aktiv >= 0) { waehle(angezeigt[aktiv]); return; }
    if (!text) return;
    const genau = eintraege.find((x) => x.key === norm(text));
    if (genau) waehle(genau);
    else sucheAdresse(text);
  });
  card.addEventListener("click", (e) => {
    const knopf = e.target.closest("[data-b]");
    if (knopf) zeigeBetreiber(Number(knopf.dataset.b));
  });
  L.DomEvent.disableClickPropagation(form);
  L.DomEvent.disableScrollPropagation(form);

  document.getElementById("stand").textContent = META.stand;
  document.getElementById("status").textContent = `${GEBIETE.features.length} Betreiber · ${GEMEINDEN.features.length.toLocaleString("de-DE")} Gemeinden`;
  window.__karte = { map, netz, show, findeGemeinde, ausgewaehlt: () => highlightB, strichStaerke };
})();
