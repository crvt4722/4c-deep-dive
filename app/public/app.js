// ShopApp frontend — KCD Vietnam 2026 demo
const money = (n) => n.toLocaleString("vi-VN") + "₫";

let allProducts = [];
let activeCategory = "All";

async function loadProducts() {
  const grid = document.getElementById("grid");
  try {
    const res = await fetch("/api/products");
    const data = await res.json();
    allProducts = data.products || [];
    renderFilters();
    renderProducts();
  } catch (e) {
    grid.innerHTML = `<div class="grid__loading">Failed to load products 😕</div>`;
  }
}

function renderFilters() {
  const cats = ["All", ...new Set(allProducts.map((p) => p.category))];
  const wrap = document.getElementById("filters");
  wrap.innerHTML = cats
    .map(
      (c) =>
        `<button class="chip ${c === activeCategory ? "is-active" : ""}" data-cat="${c}">${c}</button>`
    )
    .join("");
  wrap.querySelectorAll(".chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.cat;
      renderFilters();
      renderProducts();
    })
  );
}

function renderProducts() {
  const grid = document.getElementById("grid");
  const list =
    activeCategory === "All"
      ? allProducts
      : allProducts.filter((p) => p.category === activeCategory);

  if (!list.length) {
    grid.innerHTML = `<div class="grid__loading">No products found.</div>`;
    return;
  }

  grid.innerHTML = list
    .map(
      (p) => `
    <article class="card">
      <div class="card__media">
        ${p.badge ? `<span class="card__badge">${p.badge}</span>` : ""}
        <span>${p.emoji}</span>
      </div>
      <div class="card__body">
        <span class="card__cat">${p.category}</span>
        <div class="card__name">${p.name}</div>
        <div class="card__meta">
          <span class="card__price">${money(p.price)}</span>
          <span class="card__rating">★ ${p.rating}</span>
        </div>
        <div class="card__buy">
          <button class="btn btn--primary" data-buy="${p.id}">Add to cart</button>
        </div>
      </div>
    </article>`
    )
    .join("");

  grid.querySelectorAll("[data-buy]").forEach((b) =>
    b.addEventListener("click", () => {
      b.textContent = "✓ Added";
      b.disabled = true;
      setTimeout(() => {
        b.textContent = "Add to cart";
        b.disabled = false;
      }, 1200);
    })
  );
}

// ---- Modal (Seller / OCR) ----
const modal = document.getElementById("modal");
function openModal() {
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  document.getElementById("imagePath").focus();
}
function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = "";
}

["openSeller", "openSeller2", "openSeller3"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", openModal);
});
modal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

document.querySelectorAll(".sample").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.getElementById("imagePath").value = btn.dataset.v;
  })
);

// ---- OCR scan (calls the vulnerable endpoint) ----
document.getElementById("scanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const imagePath = document.getElementById("imagePath").value.trim();
  const result = document.getElementById("result");
  const status = document.getElementById("resultStatus");
  const text = document.getElementById("resultText");

  result.hidden = false;
  status.className = "tag";
  status.textContent = "Processing…";
  text.textContent = "";

  try {
    const res = await fetch("/api/products/scan-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagePath }),
    });
    const data = await res.json();
    if (res.ok) {
      status.className = "tag tag--ok";
      status.textContent = "Success";
      text.textContent = data.text || "(no text)";
    } else {
      status.className = "tag tag--err";
      status.textContent = "Error " + res.status;
      text.textContent = data.error || "Could not read the label.";
    }
  } catch (err) {
    status.className = "tag tag--err";
    status.textContent = "Network error";
    text.textContent = String(err);
  }
});

loadProducts();
