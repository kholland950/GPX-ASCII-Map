(() => {
	const $ = (id) => document.getElementById(id);

	const uploadSection = $("upload-section");
	const loadingSection = $("loading-section");
	const resultSection = $("result-section");
	const sectionSep = $("section-sep");
	const dropZone = $("drop-zone");
	const fileInput = $("file-input");
	const asciiOutput = $("ascii-output");
	const elevOutput = $("elev-output");
	const routeTitle = $("route-title");
	const mapAttribution = $("map-attribution");
	const statsBar = $("stats-bar");
	const actionBar = document.querySelector(".action-bar");
	const shareBtn = $("share-btn");
	const replayBtn = $("replay-btn");
	const resetBtn = $("reset-btn");
	const shareFeedback = $("share-feedback");
	const uploadError = $("upload-error");

	let currentShareId = null;

	// ── State helpers ──────────────────────────────────────────────

	function showSection(name) {
		// Upload widget stays visible in all states; compact when result is shown
		uploadSection.classList.toggle("compact", name === "result");
		loadingSection.hidden = name !== "loading";
		sectionSep.hidden = name !== "result";
		resultSection.hidden = name !== "result";
	}

	function showError(msg) {
		uploadError.textContent = `✖ ${msg}`;
		uploadError.hidden = false;
	}

	function clearError() {
		uploadError.hidden = true;
		uploadError.textContent = "";
	}

	// ── Stats rendering ────────────────────────────────────────────

	function renderStats(s) {
		const parts = [];
		parts.push(`<span><strong>${s.distanceFmt}</strong> distance</span>`);
		if (s.elevGainFmt)
			parts.push(`<span><strong>${s.elevGainFmt}</strong> gain</span>`);
		if (s.elevLossFmt)
			parts.push(`<span><strong>${s.elevLossFmt}</strong> loss</span>`);
		if (s.durationFmt)
			parts.push(`<span><strong>${s.durationFmt}</strong> moving time</span>`);
		statsBar.innerHTML = parts.join("");
	}

	// ── Map font scaling ───────────────────────────────────────────

	// Reserve ~120px for elevation + attribution below the map
	const ELEV_RESERVED = 120;

	function fitMap() {
		const lineCount = asciiOutput.textContent.split("\n").length;
		if (lineCount < 5) return;

		const header = document.querySelector("header");
		const reserved = header.getBoundingClientRect().height + uploadSection.getBoundingClientRect().height + 32 + ELEV_RESERVED;
		const availH = window.innerHeight - reserved;

		// First pass: size to fill available height
		let size = Math.max(5, Math.min(13, availH / (lineCount * 1.2)));
		asciiOutput.style.fontSize = `${size.toFixed(2)}px`;

		// Second pass: if the map overflows horizontally, scale down to fit width too
		const wrapper = asciiOutput.closest(".map-wrapper");
		if (wrapper && asciiOutput.scrollWidth > wrapper.clientWidth) {
			size = Math.max(
				5,
				size * (wrapper.clientWidth / asciiOutput.scrollWidth),
			);
			asciiOutput.style.fontSize = `${size.toFixed(2)}px`;
		}

		// Keep elevation profile at same font-size so it matches the map width exactly
		elevOutput.style.fontSize = asciiOutput.style.fontSize;

		// Constrain stats bar and action bar to the same pixel width as the rendered map
		const mapW = `${asciiOutput.offsetWidth}px`;
		statsBar.style.width = mapW;
		actionBar.style.width = mapW;
	}

	window.addEventListener("resize", fitMap);

	// ── Result display ─────────────────────────────────────────────

	function displayResult(data) {
		currentShareId = data.id;
		renderStats({ ...data.stats, pointCount: data.pointCount });

		if (data.mapHtml) {
			// Pre-size to the known fixed map dimensions (MAP_H=56 + 2 borders = 58 lines)
			// so font-size is correct on the first paint and animations never see a resize.
			const KNOWN_LINES = 58;
			const hdr = document.querySelector("header");
			const reserved = hdr.getBoundingClientRect().height + uploadSection.getBoundingClientRect().height + 32 + ELEV_RESERVED;
			const availH = window.innerHeight - reserved;
			const preSize = Math.max(5, Math.min(13, availH / (KNOWN_LINES * 1.2)));
			asciiOutput.style.fontSize = `${preSize.toFixed(2)}px`;
			elevOutput.style.fontSize = `${preSize.toFixed(2)}px`;

			// Delay all CSS animations until after the smooth scroll finishes (~600ms).
			resultSection.style.setProperty("--scroll-offset", "650ms");

			// New structured format
			asciiOutput.innerHTML = data.mapHtml;
			routeTitle.textContent = data.routeName || "";
			routeTitle.hidden = !data.routeName;
			if (data.elevHtml) {
				elevOutput.innerHTML = data.elevHtml;
				elevOutput.hidden = false;
			} else {
				elevOutput.hidden = true;
			}
			mapAttribution.hidden = false;
		} else if (data.format === "html") {
			// Legacy format — single pre blob
			asciiOutput.innerHTML = data.ascii;
			routeTitle.hidden = true;
			elevOutput.hidden = true;
			mapAttribution.hidden = true;
		} else {
			asciiOutput.textContent = data.ascii;
			routeTitle.hidden = true;
			elevOutput.hidden = true;
			mapAttribution.hidden = true;
		}

		showSection("result");
		history.replaceState({}, "", `?s=${data.id}`);
		fitMap();
		resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	// ── Upload ─────────────────────────────────────────────────────

	async function uploadFile(file) {
		if (!file || !file.name.toLowerCase().endsWith(".gpx")) {
			showError("Please upload a .gpx file.");
			return;
		}

		clearError();
		showSection("loading");

		const formData = new FormData();
		formData.append("gpx", file);

		try {
			const resp = await fetch("/api/upload", {
				method: "POST",
				body: formData,
			});
			const data = await resp.json();

			if (!resp.ok) {
				showSection("upload");
				showError(data.error || "Upload failed.");
				return;
			}

			displayResult(data);
		} catch {
			showSection("upload");
			showError("Network error — is the server running?");
		}
	}

	// ── Drag & drop ────────────────────────────────────────────────

	dropZone.addEventListener("click", () => fileInput.click());
	dropZone.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") fileInput.click();
	});
	fileInput.addEventListener("change", () => {
		if (fileInput.files[0]) uploadFile(fileInput.files[0]);
	});

	dropZone.addEventListener("dragover", (e) => {
		e.preventDefault();
		dropZone.classList.add("drag-over");
	});
	dropZone.addEventListener("dragleave", () =>
		dropZone.classList.remove("drag-over"),
	);
	dropZone.addEventListener("drop", (e) => {
		e.preventDefault();
		dropZone.classList.remove("drag-over");
		const file = e.dataTransfer.files[0];
		if (file) uploadFile(file);
	});

	// ── Replay button ──────────────────────────────────────────────

	replayBtn.addEventListener("click", () => {
		// No scroll this time — start immediately
		resultSection.style.setProperty("--scroll-offset", "0ms");
		asciiOutput.classList.add("no-animate");
		elevOutput.classList.add("no-animate");
		void asciiOutput.offsetWidth; // flush so browser sees animation: none
		asciiOutput.classList.remove("no-animate");
		elevOutput.classList.remove("no-animate");
	});

	// ── Share button ───────────────────────────────────────────────

	shareBtn.addEventListener("click", async () => {
		if (!currentShareId) return;
		const url = `${location.origin}${location.pathname}?s=${currentShareId}`;
		try {
			await navigator.clipboard.writeText(url);
			showFeedback("link copied!");
		} catch {
			prompt("Copy this link:", url);
		}
	});

	resetBtn.addEventListener("click", () => {
		currentShareId = null;
		fileInput.value = "";
		asciiOutput.textContent = "";
		elevOutput.innerHTML = "";
		elevOutput.hidden = true;
		routeTitle.textContent = "";
		routeTitle.hidden = true;
		statsBar.innerHTML = "";
		clearError();
		history.replaceState({}, "", location.pathname);
		showSection("upload");
	});

	function showFeedback(msg) {
		shareFeedback.textContent = `✔ ${msg}`;
		shareFeedback.hidden = false;
		shareFeedback.style.animation = "none";
		void shareFeedback.offsetWidth; // reflow to restart animation
		shareFeedback.style.animation = "";
		setTimeout(() => {
			shareFeedback.hidden = true;
		}, 2600);
	}

	// ── Load shared route on page load ─────────────────────────────

	async function loadSharedRoute(id) {
		showSection("loading");
		try {
			const resp = await fetch(`/api/share/${id}`);
			const data = await resp.json();
			if (!resp.ok) {
				showSection("upload");
				showError(data.error || "Route not found.");
				return;
			}
			displayResult(data);
		} catch {
			showSection("upload");
			showError("Could not load shared route.");
		}
	}

	const params = new URLSearchParams(location.search);
	const shareId = params.get("s");
	if (shareId && /^[a-f0-9]+$/i.test(shareId)) {
		loadSharedRoute(shareId);
	} else {
		showSection("upload");
	}
})();
