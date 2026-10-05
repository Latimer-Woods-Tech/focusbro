const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf-8');

// Ensure initGallery() contains robust fallback logic so generated module is safe
try {
	const startMarker = 'async function initGallery() {';
	const renderMarker = '\n\n  function renderGallery() {';
	const startIdx = html.indexOf(startMarker);
	const renderIdx = html.indexOf(renderMarker, startIdx);

	if (startIdx !== -1 && renderIdx !== -1 && renderIdx > startIdx) {
		const newInit = `async function initGallery() {
			try {
				const userId = getOrCreateUserId();
				const category = 'random';

				// Fetch gallery from API with timeout and safe parse
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 5000);
				let response = null;
				try {
					const url = '/api/gallery?seed=' + encodeURIComponent(userId) + '&category=' + category + '&limit=12';
					response = await fetch(url, { signal: controller.signal });
				} catch (fetchErr) {
					console.warn('Gallery fetch failed:', fetchErr && fetchErr.message);
				} finally {
					clearTimeout(timeout);
				}

				let data = null;
				if (response && response.ok) {
					try { data = await response.json(); } catch (jsonErr) { console.warn('initGallery: invalid JSON from API:', jsonErr && jsonErr.message); }
					if (data && Array.isArray(data.images) && data.images.length > 0) {
						galleryImages = data.images.map(img => ({
							title: 'Motivational Image - ' + (data.category || category),
							quote: img.quote || 'Keep pushing. Every moment of focus counts.',
							url: img.url,
							alt: img.alt || 'Motivational image'
						}));
						log('✅ Loaded ' + galleryImages.length + ' images from API');
						currentGalleryIndex = 0;
						renderGallery();
						return;
					} else {
						console.warn('Gallery API returned no images or invalid data; using fallback.');
					}
				} else {
					console.warn('Gallery API non-OK response; using fallback.', response && response.status);
				}
			} catch (e) {
				console.warn('Gallery API unavailable, using fallback SVGs:', e && e.message);
			}

			// Fallback
			galleryImages = [...FALLBACK_GALLERY];
			currentGalleryIndex = 0;
			renderGallery();
		}`;

		html = html.slice(0, startIdx) + newInit + html.slice(renderIdx);
	}
} catch (e) {
	console.warn('create-html-module: failed to patch initGallery in source HTML:', e && e.message);
}

// Use JSON.stringify to properly escape the HTML string, avoiding backtick escaping issues
const jsonString = JSON.stringify(html);
const content = `// Auto-generated HTML content - do not edit\nconst htmlContent = ${jsonString};\n\nexport default htmlContent;\n`;
fs.writeFileSync('api/src/html.js', content);
console.log('Created api/src/html.js with HTML embedded (' + html.length + ' bytes)');

// The service worker, same treatment: public/sw.js is the one source (G797).
// swContentHash names the cache when the Worker has no BUILD_SHA (FBQ-04).
const sw = fs.readFileSync('public/sw.js', 'utf-8');
const swContentHash = require('crypto').createHash('sha256').update(html).update(sw).digest('hex').slice(0, 16);
fs.writeFileSync('api/src/sw-source.js', `// Auto-generated from public/sw.js by create-html-module.js - do not edit\nconst swSource = ${JSON.stringify(sw)};\n\nexport const swContentHash = '${swContentHash}';\n\nexport default swSource;\n`);
console.log('Created api/src/sw-source.js from public/sw.js (' + sw.length + ' bytes, hash ' + swContentHash + ')');
