DEVICE ?= tv
APP_ID = com.joaovargass.stremiodbg
SERVER_VERSION = 4.20.17
VIDAA_REF = 208d437e5138adff0865443a2a88c4fcee84ece6
VIDAA_REPO = https://github.com/NoobyGains/stremio-vidaa-tv/archive/$(VIDAA_REF).tar.gz
TWEAKS = tweaks.json webos-ui.css webos-shared.js webos-evidence.js webos-recs.js webos-enhance.js webos-retry.js webos-subs.js webos-subsync.js webos-doctor.js webos-sources.js webos-settings.js webos-diag.js webos-home.js webos-layer.js webos-debug.js webos-i18n.js webos-logview.js
VERSION = $(shell python3 -c "import json; print(json.load(open('app/appinfo.json'))['version'])")
IPK = $(APP_ID)_$(VERSION)_all.ipk
STAGE = /tmp/stremio-webos-package

.PHONY: build package deploy launch restart clean ffmpeg

service/server.js:
	@echo "==> Downloading Stremio server v$(SERVER_VERSION)..."
	@curl -so $@ "https://dl.strem.io/server/v$(SERVER_VERSION)/webos/server.js"
	@python3 tools/patch-webos-server.py $@

# Small static ffmpeg and ffprobe built for the TV (about 18 MB together), see tools/build-ffmpeg.sh
service/bin/ffmpeg service/bin/ffprobe:
	@./tools/build-ffmpeg.sh

ffmpeg: service/bin/ffmpeg service/bin/ffprobe

build: service/server.js
	@echo "==> Downloading Vidaa frontend..."
	@rm -rf /tmp/stremio-vidaa-build && mkdir -p /tmp/stremio-vidaa-build
	@curl -sL $(VIDAA_REPO) | tar xz --strip-components=1 -C /tmp/stremio-vidaa-build
	@echo "==> Building service/www/..."
	@rm -rf service/www && mkdir -p service/www
	@cp /tmp/stremio-vidaa-build/*.js /tmp/stremio-vidaa-build/*.wasm /tmp/stremio-vidaa-build/*.ttf /tmp/stremio-vidaa-build/*.png /tmp/stremio-vidaa-build/*.svg service/www/
	@cp service/index.html service/www/index.html
	@for f in $(TWEAKS); do cp service/$$f service/www/$$f; done
	@rm -rf /tmp/stremio-vidaa-build
	@for p in patches/*.patch; do \
		echo "    Applying $$(basename $$p)..."; \
		patch -p0 --no-backup-if-mismatch -d service/www < "$p"; \
	done
	@echo "==> Build complete"

# Only the files the TV runs go into the package: no dotfiles, patch backups or files of the upstream repo tooling
package: build ffmpeg
	@rm -f $(IPK)
	@rm -rf $(STAGE) && mkdir -p $(STAGE)
	@rsync -a --exclude '.*' --exclude '*.orig' --exclude 'playwright.config.js' app service $(STAGE)/
	@ares-package --no-minify $(STAGE)/app $(STAGE)/service -o .

deploy: package
	@for i in 1 2 3 4 5; do \
		ares-install --device $(DEVICE) $(IPK) && break || sleep 3; \
	done
	@ares-launch --device $(DEVICE) $(APP_ID)

launch:
	@ares-launch --device $(DEVICE) $(APP_ID)

restart:
	@-ares-launch --device $(DEVICE) --close $(APP_ID)
	@sleep 1
	@ares-launch --device $(DEVICE) $(APP_ID)

clean:
	rm -rf service/www service/server.js service/bin *.ipk
