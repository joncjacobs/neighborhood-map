(function () {
  "use strict";

  // Refuse to run inside another site's frame (GitHub Pages can't send the header for this).
  if (window.top !== window.self) {
    document.body.textContent = "";
    return;
  }

  const LABEL_FULL_ZOOM = 19;          // below this, labels show surnames only
  const REFRESH_AFTER_MS = 30 * 1000;  // re-fetch when the app returns to the foreground
  const PHOTO_MAX_PX = 800;
  const SIGNED_URL_SECONDS = 15 * 60;  // photo links stop working after this

  const cfg = window.APP_CONFIG || {};
  const configured = cfg.supabaseUrl && !/YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
  const db = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const $ = (id) => document.getElementById(id);

  // ---- State --------------------------------------------------------------
  const households = new Map(); // parcel -> row
  const people = new Map();     // parcel -> [rows], sorted
  const photoUrls = new Map();  // photo_path -> { url, expires }
  let lastLoad = 0;
  let openParcel = null;
  let editing = null;           // { kind: "household" | "person" | "new-person", id }

  // ---- Basemaps -----------------------------------------------------------
  const satellite = L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21, maxNativeZoom: 19, opacity: 0.8,
    }),
  ]);
  const streets = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 21, maxNativeZoom: 20, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  });

  // The public page knows nothing about where the lots are: it starts on a
  // country-wide view and only zooms in once the lots load after sign-in.
  const NEUTRAL_VIEW = [[39.5, -98.35], 4];
  const LOT_ATTRIBUTION = "Parcels: county GIS";
  const map = L.map("map", { zoomControl: true, maxZoom: 21, layers: [satellite] });
  map.setView(...NEUTRAL_VIEW);

  // ---- Helpers ------------------------------------------------------------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fullName(p) {
    return [p.first_name, p.last_name].filter(Boolean).join(" ");
  }
  function joinList(items) {
    return items.length <= 2 ? items.join(" & ") : items.slice(0, -1).join(", ") + " & " + items[items.length - 1];
  }
  function peopleOf(parcel) {
    return people.get(parcel) || [];
  }
  // "Daniel & Nicole Arb", "Evan Eby & Devon McVey", or the household's override.
  function labelFor(parcel) {
    const h = households.get(parcel);
    if (!h) return null;
    if (h.display_name) return h.display_name;
    const ps = peopleOf(parcel);
    const adults = ps.filter((p) => p.role === "adult");
    const list = adults.length ? adults : ps;
    if (!list.length) return null;
    const lasts = new Set(list.map((p) => p.last_name || ""));
    if (lasts.size === 1) {
      const last = list[0].last_name;
      return joinList(list.map((p) => p.first_name)) + (last ? " " + last : "");
    }
    return joinList(list.map(fullName));
  }
  function shortLabelFor(parcel) {
    const h = households.get(parcel);
    if (!h) return "";
    if (h.display_name) return h.display_name.split(/\s+/).slice(0, 2).join(" ");
    const lasts = [...new Set(peopleOf(parcel).filter((p) => p.role === "adult").map((p) => p.last_name).filter(Boolean))];
    return lasts.join(" / ") || (labelFor(parcel) || "—");
  }
  // Show the tax-bill name only when none of its words match anyone we have listed
  // (e.g. a bill still in the previous owner's name).
  function taxNameDiffers(parcel) {
    const h = households.get(parcel);
    if (!h || !h.tax_name) return false;
    const words = (s) => (s || "").toLowerCase().match(/[a-z]{2,}/g) || [];
    const ignore = new Set(["llc", "trust", "inc", "properties", "jtrs", "tc"]);
    const taxWords = new Set(words(h.tax_name).filter((w) => !ignore.has(w)));
    const ours = [h.display_name, ...peopleOf(parcel).map((p) => p.last_name)].flatMap(words);
    return !ours.some((w) => taxWords.has(w));
  }
  function streetLabel(p) {
    return p.address.replace(/^\d+\s+/, "");
  }
  function telHref(phone) {
    return "tel:" + String(phone).replace(/[^\d+]/g, "");
  }
  function showStatus(msg, ms) {
    const el = $("status");
    el.textContent = msg;
    el.hidden = !msg;
    clearTimeout(showStatus.t);
    if (msg && ms) showStatus.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---- Lots ---------------------------------------------------------------
  const baseStyle = { color: "#f59e0b", weight: 2, fillColor: "#f59e0b", fillOpacity: 0.15 };
  const hoverStyle = { weight: 3, fillOpacity: 0.4 };
  const dimStyle = { weight: 1, fillOpacity: 0.04, opacity: 0.4 };
  const selectedStyle = { color: "#ffffff", weight: 3, fillOpacity: 0.35 };
  const entries = []; // { p: { parcel, address }, layer, center, match }
  const byParcel = new Map();
  const lots = L.featureGroup().addTo(map);

  // Lot outlines come from the database (households.geometry), so they only
  // exist on the page while someone allowed is signed in.
  function buildLots() {
    lots.clearLayers();
    entries.length = 0;
    byParcel.clear();
    households.forEach((h) => {
      if (!h.geometry) return;
      const p = { parcel: h.parcel, address: h.address };
      const layer = L.geoJSON(h.geometry, { style: () => baseStyle });
      const entry = { p, layer, center: layer.getBounds().getCenter(), match: true };
      entries.push(entry);
      byParcel.set(p.parcel, entry);
      layer.on("click", () => { if (openDetail(p.parcel)) revealLot(entry); });
      if (canHover) {
        layer.bindTooltip("", { className: "hover-tip", direction: "top", sticky: true, offset: [0, -8] });
        layer.on("mouseover", () => layer.setStyle(hoverStyle));
        layer.on("mouseout", () => applyStyle(entry));
      }
      lots.addLayer(layer);
      applyStyle(entry);
    });
  }

  function applyStyle(entry) {
    const style = Object.assign({}, baseStyle, entry.match ? {} : dimStyle, entry.p.parcel === openParcel ? selectedStyle : {});
    entry.layer.setStyle(style);
  }
  function refreshTooltips() {
    if (!canHover) return;
    entries.forEach((e) => {
      const name = labelFor(e.p.parcel);
      e.layer.setTooltipContent(name ? `<b>${esc(name)}</b><span>${esc(e.p.address)}</span>` : `<b>${esc(e.p.address)}</b>`);
    });
  }

  // Re-fit when the map's size changes (e.g. it loaded in a hidden tab or the
  // phone rotated), until the person starts moving the map themselves.
  let userMoved = false;
  let fitted = false;
  const fitAll = () => { if (entries.length) map.fitBounds(lots.getBounds(), { padding: [20, 20] }); };
  ["mousedown", "touchstart", "wheel"].forEach((t) =>
    map.getContainer().addEventListener(t, () => { userMoved = true; }, { passive: true }));
  new ResizeObserver(() => {
    map.invalidateSize();
    if (!userMoved) fitAll();
  }).observe(map.getContainer());

  // ---- Name labels (permanent tooltips at lot centers) ---------------------
  const labelLayer = L.layerGroup();
  let namesOn = false;

  function buildLabels() {
    labelLayer.clearLayers();
    if (!namesOn) return;
    const full = map.getZoom() >= LABEL_FULL_ZOOM;
    entries.forEach((e) => {
      if (!e.match || !households.size) return;
      const text = full ? (labelFor(e.p.parcel) || "—") : shortLabelFor(e.p.parcel);
      const m = L.marker(e.center, { opacity: 0, interactive: false, keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0] }) });
      m.bindTooltip(esc(text), { permanent: true, direction: "center", className: "lot-label", interactive: false });
      labelLayer.addLayer(m);
    });
  }
  map.on("zoomend", buildLabels);

  $("namesBtn").addEventListener("click", () => {
    namesOn = !namesOn;
    $("namesBtn").setAttribute("aria-pressed", String(namesOn));
    $("namesBtn").textContent = namesOn ? "Hide names" : "Show names";
    if (namesOn) labelLayer.addTo(map); else map.removeLayer(labelLayer);
    buildLabels();
  });

  // ---- Basemap toggle -----------------------------------------------------
  let onStreets = false;
  $("baseBtn").addEventListener("click", () => {
    onStreets = !onStreets;
    map.removeLayer(onStreets ? satellite : streets);
    (onStreets ? streets : satellite).addTo(map);
    $("baseBtn").textContent = onStreets ? "Satellite" : "Street map";
  });

  // ---- Menu ---------------------------------------------------------------
  function setMenu(open) {
    $("menu").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  }
  $("menuBtn").addEventListener("click", (ev) => { ev.stopPropagation(); setMenu($("menu").hidden); });
  document.addEventListener("click", () => setMenu(false));
  $("signOutBtn").addEventListener("click", () => db && db.auth.signOut());
  $("exportBtn").addEventListener("click", exportData);

  // ---- Panels -------------------------------------------------------------
  function setPanel(open) {
    $("panel").hidden = !open;
    $("listBtn").setAttribute("aria-pressed", String(open));
    if (open) closeDetail();
  }
  $("listBtn").addEventListener("click", () => setPanel($("panel").hidden));
  $("closePanel").addEventListener("click", () => setPanel(false));

  function renderList() {
    const q = $("search").value.trim().toLowerCase();
    let html = "";
    let lastStreet = null;
    let count = 0;
    const sorted = entries.slice().sort((a, b) =>
      streetLabel(a.p).localeCompare(streetLabel(b.p)) || parseInt(a.p.address, 10) - parseInt(b.p.address, 10));
    sorted.forEach((e) => {
      const h = households.get(e.p.parcel) || {};
      const hay = [labelFor(e.p.parcel), e.p.address, h.pets, h.how_we_know, h.notes,
        ...peopleOf(e.p.parcel).flatMap((p) => [fullName(p), p.notes, p.age_grade, p.job])].join(" ").toLowerCase();
      e.match = !q || hay.includes(q);
      applyStyle(e);
      if (!e.match) return;
      const street = streetLabel(e.p);
      if (street !== lastStreet) { html += `<h2>${esc(street)}</h2>`; lastStreet = street; }
      html += `<button data-parcel="${esc(e.p.parcel)}"><div class="who">${esc(labelFor(e.p.parcel) || "Unknown")}</div><div class="where">${esc(e.p.address)}</div></button>`;
      count++;
    });
    $("list").innerHTML = count ? html : '<div class="empty">No matches.</div>';
    buildLabels();
  }
  $("search").addEventListener("input", renderList);
  $("list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-parcel]");
    if (!btn) return;
    const e = byParcel.get(btn.dataset.parcel);
    setPanel(false);
    openDetail(e.p.parcel);
    focusLot(e, Math.max(map.getZoom(), 19));
  });

  // The detail panel covers the bottom of the map on phones and the right side
  // on wider screens; aim the lot at the middle of the part still visible.
  function coveredOffset() {
    const d = $("detail");
    if (d.hidden) return L.point(0, 0);
    return window.innerWidth <= 640 ? L.point(0, d.offsetHeight / 2) : L.point((d.offsetWidth + 12) / 2, 0);
  }
  function focusLot(e, zoom) {
    const target = map.unproject(map.project(e.center, zoom).add(coveredOffset()), zoom);
    map.flyTo(target, zoom, { duration: 0.6 });
  }
  // On a tap, only move the map if the lot ended up under the panel.
  function revealLot(e) {
    const d = $("detail");
    const pt = map.latLngToContainerPoint(e.center);
    const size = map.getSize();
    const hidden = window.innerWidth <= 640 ? pt.y > size.y - d.offsetHeight - 20 : pt.x > size.x - d.offsetWidth - 32;
    if (hidden) focusLot(e, map.getZoom());
  }

  // ---- Detail panel ---------------------------------------------------------
  function openDetail(parcel) {
    if (editing && openParcel !== parcel && !confirm("Discard your unsaved changes?")) return false;
    editing = null;
    $("panel").hidden = true;
    $("listBtn").setAttribute("aria-pressed", "false");
    const prev = openParcel;
    openParcel = parcel;
    if (prev && byParcel.has(prev)) applyStyle(byParcel.get(prev));
    applyStyle(byParcel.get(parcel));
    renderDetail();
    $("detail").hidden = false;
    return true;
  }
  function closeDetail() {
    const prev = openParcel;
    openParcel = null;
    editing = null;
    $("detail").hidden = true;
    if (prev && byParcel.has(prev)) applyStyle(byParcel.get(prev));
  }

  function personCard(p) {
    const photo = p.photo_path
      ? `<img class="avatar" data-photo="${esc(p.photo_path)}" alt="">`
      : `<div class="avatar initials">${esc((p.first_name || "?")[0])}${esc((p.last_name || "")[0] || "")}</div>`;
    const meta = [p.role === "child" ? "Child" : null, p.age_grade, p.job].filter(Boolean).join(" · ");
    const contact = [
      p.phone ? `<a href="${esc(telHref(p.phone))}">${esc(p.phone)}</a>` : "",
      p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="person">
      ${photo}
      <div class="person-body">
        <div class="who">${esc(fullName(p))}</div>
        ${meta ? `<div class="muted">${esc(meta)}</div>` : ""}
        ${contact ? `<div class="contact">${contact}</div>` : ""}
        ${p.notes ? `<div class="note-text">${esc(p.notes)}</div>` : ""}
      </div>
      <button class="link" data-action="edit-person" data-id="${esc(p.id)}">Edit</button>
    </div>`;
  }

  function personForm(p) {
    const v = (k) => esc(p ? p[k] : "");
    const isNew = !p;
    return `<form class="edit-form" data-form="person" data-id="${isNew ? "" : esc(p.id)}">
      <div class="row2">
        <label>First name <input name="first_name" value="${v("first_name")}" required></label>
        <label>Last name <input name="last_name" value="${v("last_name")}"></label>
      </div>
      <div class="row2">
        <label>Adult or child
          <select name="role">
            <option value="adult"${!p || p.role === "adult" ? " selected" : ""}>Adult</option>
            <option value="child"${p && p.role === "child" ? " selected" : ""}>Child</option>
          </select>
        </label>
        <label>Age / grade <input name="age_grade" value="${v("age_grade")}" placeholder="e.g. 7, 2nd grade"></label>
      </div>
      <label>Job <input name="job" value="${v("job")}" placeholder="e.g. Nurse at Community North"></label>
      <div class="row2">
        <label>Phone <input name="phone" type="tel" value="${v("phone")}"></label>
        <label>Email <input name="email" type="email" value="${v("email")}"></label>
      </div>
      <label>Notes <textarea name="notes" rows="3">${v("notes")}</textarea></label>
      ${isNew ? "" : `<div class="photo-row">
        <label class="file-btn">${p.photo_path ? "Replace photo" : "Add photo"}
          <input type="file" name="photo" accept="image/*" hidden>
        </label>
        ${p.photo_path ? '<button type="button" class="link danger" data-action="remove-photo">Remove photo</button>' : ""}
      </div>`}
      <div class="form-actions">
        ${isNew ? "" : '<button type="button" class="link danger" data-action="delete-person">Delete person</button>'}
        <span class="spacer"></span>
        <button type="button" data-action="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>`;
  }

  function householdForm(h) {
    const v = (k) => esc(h[k]);
    return `<form class="edit-form" data-form="household">
      <label>Map label <input name="display_name" value="${v("display_name")}" placeholder="Leave blank to use the adults' names"></label>
      <label>Pets <input name="pets" value="${v("pets")}"></label>
      <label>How we know them <input name="how_we_know" value="${v("how_we_know")}"></label>
      <label>Notes <textarea name="notes" rows="4">${v("notes")}</textarea></label>
      <div class="form-actions">
        <span class="spacer"></span>
        <button type="button" data-action="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>`;
  }

  function renderDetail() {
    const el = $("detail");
    const parcel = openParcel;
    if (!parcel) return;
    const lot = byParcel.get(parcel).p;
    const h = households.get(parcel);
    if (!h) {
      el.innerHTML = `<div class="detail-head"><div><h2>${esc(lot.address)}</h2></div>
        <button class="icon" data-action="close" aria-label="Close">&times;</button></div>
        <div class="detail-body"><p class="muted">Sign in to see who lives here.</p></div>`;
      return;
    }
    const ps = peopleOf(parcel);
    const adults = ps.filter((p) => p.role === "adult");
    const kids = ps.filter((p) => p.role === "child");
    const section = (title, list) => list.length ? `<h3>${title}</h3>` + list.map((p) =>
      editing && editing.kind === "person" && editing.id === p.id ? personForm(p) : personCard(p)).join("") : "";

    const hhInfo = editing && editing.kind === "household" ? householdForm(h) : `
      <div class="hh-info">
        ${h.pets ? `<div><span class="k">Pets</span> ${esc(h.pets)}</div>` : ""}
        ${h.how_we_know ? `<div><span class="k">How we know them</span> ${esc(h.how_we_know)}</div>` : ""}
        ${h.notes ? `<div class="note-text">${esc(h.notes)}</div>` : ""}
        ${!h.pets && !h.how_we_know && !h.notes ? '<div class="muted">No notes yet.</div>' : ""}
        <button class="link" data-action="edit-household">Edit household</button>
      </div>`;

    el.innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${esc(labelFor(parcel) || "Unknown")}</h2>
          <div class="muted">${esc(lot.address)}</div>
        </div>
        <button class="icon" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="detail-body">
        ${taxNameDiffers(parcel) ? `<div class="tax-note">Tax bill: ${esc(h.tax_name)}</div>` : ""}
        ${!h.tax_name && !ps.length ? '<div class="tax-note">The county withholds the owner\'s name for this lot.</div>' : ""}
        ${section("Adults", adults)}
        ${section("Kids", kids)}
        ${editing && editing.kind === "new-person" ? "<h3>New person</h3>" + personForm(null)
          : '<button class="add-btn" data-action="add-person">+ Add person</button>'}
        <h3>Household</h3>
        ${hhInfo}
      </div>`;
    loadPhotos(el);
  }

  async function loadPhotos(root) {
    const imgs = [...root.querySelectorAll("img[data-photo]")];
    const now = Date.now();
    const need = [...new Set(imgs.map((i) => i.dataset.photo))]
      .filter((path) => !(photoUrls.get(path) && photoUrls.get(path).expires > now + 60000));
    if (need.length) {
      const { data, error } = await db.storage.from("photos").createSignedUrls(need, SIGNED_URL_SECONDS);
      if (error) { showStatus("Couldn't load photos: " + error.message, 5000); return; }
      data.forEach((d) => d.signedUrl && photoUrls.set(d.path, { url: d.signedUrl, expires: now + SIGNED_URL_SECONDS * 1000 }));
    }
    imgs.forEach((img) => {
      const u = photoUrls.get(img.dataset.photo);
      if (u) img.src = u.url;
    });
  }

  $("detail").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "close") {
      if (editing && !confirm("Discard your unsaved changes?")) return;
      closeDetail();
    } else if (action === "edit-person") {
      editing = { kind: "person", id: btn.dataset.id }; renderDetail();
    } else if (action === "add-person") {
      editing = { kind: "new-person" }; renderDetail();
    } else if (action === "edit-household") {
      editing = { kind: "household" }; renderDetail();
    } else if (action === "cancel") {
      editing = null; renderDetail();
    } else if (action === "delete-person") {
      const p = findPerson(editing.id);
      if (!confirm(`Delete ${fullName(p)}?`)) return;
      await deletePerson(p);
    } else if (action === "remove-photo") {
      await setPhoto(findPerson(editing.id), null);
    }
  });

  $("detail").addEventListener("change", async (ev) => {
    if (ev.target.name !== "photo" || !ev.target.files.length) return;
    await setPhoto(findPerson(editing.id), ev.target.files[0]);
  });

  $("detail").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const fields = Object.fromEntries([...new FormData(form)].filter(([k]) => k !== "photo")
      .map(([k, v]) => [k, String(v).trim() || null]));
    form.querySelector('button[type="submit"]').disabled = true;
    if (form.dataset.form === "household") await saveHousehold(fields);
    else if (form.dataset.id) await savePerson(findPerson(form.dataset.id), fields);
    else await addPerson(fields);
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = false;
  });

  function findPerson(id) {
    return peopleOf(openParcel).find((p) => p.id === id);
  }

  // ---- Writes (with a guard against overwriting the other person's edits) --
  // Each update only matches if the row still has the updated_at we loaded.
  async function guardedUpdate(table, keyCol, row, fields) {
    const { data, error } = await db.from(table).update(fields)
      .eq(keyCol, row[keyCol]).eq("updated_at", row.updated_at).select();
    if (error) { showStatus("Couldn't save: " + error.message, 6000); return null; }
    if (data.length) return data[0];
    const { data: latest } = await db.from(table).select("*").eq(keyCol, row[keyCol]).maybeSingle();
    if (!latest) { showStatus("This was deleted on another device.", 6000); await loadAll(); return null; }
    const overwrite = confirm("This was changed on another device after you opened it.\n\n" +
      "OK: save your version over theirs.\nCancel: discard your edits and show the latest.");
    if (overwrite) return guardedUpdate(table, keyCol, latest, fields);
    await loadAll();
    editing = null;
    renderDetail();
    return null;
  }

  async function saveHousehold(fields) {
    const saved = await guardedUpdate("households", "parcel", households.get(openParcel), fields);
    if (!saved) return;
    households.set(saved.parcel, saved);
    editing = null;
    afterChange();
  }

  async function savePerson(p, fields) {
    const saved = await guardedUpdate("people", "id", p, fields);
    if (!saved) return;
    replacePerson(saved);
    editing = null;
    afterChange();
  }

  async function addPerson(fields) {
    const sort = peopleOf(openParcel).length;
    const { data, error } = await db.from("people").insert(Object.assign({ parcel: openParcel, sort }, fields)).select().single();
    if (error) { showStatus("Couldn't add: " + error.message, 6000); return; }
    people.set(openParcel, [...peopleOf(openParcel), data]);
    editing = { kind: "person", id: data.id }; // stay open so a photo can be added
    afterChange();
  }

  async function deletePerson(p) {
    const { error } = await db.from("people").delete().eq("id", p.id);
    if (error) { showStatus("Couldn't delete: " + error.message, 6000); return; }
    if (p.photo_path) await db.storage.from("photos").remove([p.photo_path]);
    people.set(p.parcel, peopleOf(p.parcel).filter((x) => x.id !== p.id));
    editing = null;
    afterChange();
  }

  async function setPhoto(p, file) {
    let path = null;
    if (file) {
      showStatus("Uploading photo…");
      let blob;
      try { blob = await shrinkImage(file); } catch (e) { showStatus("Couldn't read that image.", 5000); return; }
      path = `${p.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await db.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
      if (error) { showStatus("Upload failed: " + error.message, 6000); return; }
    }
    const saved = await guardedUpdate("people", "id", p, { photo_path: path });
    if (!saved) { if (path) await db.storage.from("photos").remove([path]); return; }
    if (p.photo_path) await db.storage.from("photos").remove([p.photo_path]);
    replacePerson(saved);
    showStatus(file ? "Photo saved." : "Photo removed.", 2500);
    renderDetail();
  }

  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    });
  }

  function replacePerson(saved) {
    people.set(saved.parcel, peopleOf(saved.parcel).map((x) => (x.id === saved.id ? saved : x)));
  }

  function afterChange() {
    refreshTooltips();
    renderList();
    renderDetail();
  }

  // ---- Loading ------------------------------------------------------------
  async function loadAll() {
    const [hh, ps] = await Promise.all([
      db.from("households").select("*"),
      db.from("people").select("*").order("sort").order("first_name"),
    ]);
    if (hh.error || ps.error) {
      showStatus("Couldn't load data: " + (hh.error || ps.error).message);
      return;
    }
    households.clear();
    people.clear();
    hh.data.forEach((h) => households.set(h.parcel, h));
    ps.data.forEach((p) => people.set(p.parcel, [...peopleOf(p.parcel), p]));
    lastLoad = Date.now();
    buildLots();
    if (!households.size) showStatus("This account doesn't have access to the neighbor data.");
    else if (!entries.length) showStatus("No lot shapes in the database yet (run add-lot-shapes.sql).");
    else showStatus("");
    if (!fitted && entries.length) {
      fitAll();
      fitted = true;
      map.attributionControl.addAttribution(LOT_ATTRIBUTION);
    }
    refreshTooltips();
    renderList();
    if (openParcel && !editing) renderDetail();
  }

  function clearData() {
    households.clear();
    people.clear();
    photoUrls.clear();
    lastLoad = 0;
    closeDetail();
    buildLots();
    labelLayer.clearLayers();
    if (fitted) map.attributionControl.removeAttribution(LOT_ATTRIBUTION);
    fitted = false;
    userMoved = false;
    map.setView(...NEUTRAL_VIEW);
    renderList();
  }

  // Re-fetch when the app comes back to the foreground, unless a form is open.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && households.size && !editing && Date.now() - lastLoad > REFRESH_AFTER_MS) {
      loadAll();
    }
  });

  // ---- Export -------------------------------------------------------------
  async function exportData() {
    await loadAll();
    const out = {
      exportedAt: new Date().toISOString(),
      note: "Photos are not included; photo_path points into the Supabase 'photos' bucket.",
      households: [...households.values()],
      people: [...people.values()].flat(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = `neighborhood-map-${out.exportedAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- Auth ---------------------------------------------------------------
  function showLogin(show, message) {
    $("login").hidden = !show;
    $("loginError").hidden = !message;
    $("loginError").textContent = message || "";
  }

  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    const { error } = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    btn.disabled = false;
    if (error) showLogin(true, error.message);
    else $("password").value = "";
  });

  renderList();
  if (!db) {
    showLogin(true, "Not set up yet: add your Supabase URL and anon key to config.js.");
    $("loginForm").querySelector("button").disabled = true;
  } else {
    db.auth.onAuthStateChange((event, session) => {
      if (session) {
        showLogin(false);
        // supabase-js re-sends SIGNED_IN when the tab regains focus; only load if
        // we have nothing yet (the visibility handler covers refreshes).
        // Deferred so the auth callback returns before we query.
        if (!households.size && !lastLoad) setTimeout(loadAll, 0);
      } else {
        clearData();
        showLogin(true);
      }
    });
  }
})();
