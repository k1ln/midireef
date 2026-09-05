# MidiReef — Entwicklung auf dem Mac, Betrieb auf dem Raspberry Pi.
# Details und Ersteinrichtung: deploy/README.md
.DEFAULT_GOAL := help
.PHONY: help setup dev watch hmr deploy push server ui logs kiosk-restart kiosk-url kiosk-rotate status shell

help: ## Diese Übersicht
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk -F':.*?## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Einmalige Einrichtung des Pi (Pakete, Dienste, Autostart)
	@deploy/bootstrap.sh

dev: ## Einmal Server + UI auf den Pi deployen (Debug-Build)
	@deploy/dev.sh all

server: ## Nur den Server deployen
	@deploy/dev.sh server

ui: ## Nur das UI deployen
	@deploy/dev.sh ui

watch: ## Bei jedem Speichern automatisch deployen
	@deploy/watch.sh

hmr: ## UI live vom Mac in den Pi-Kiosk (HMR, kein Build) — Ctrl-C beendet
	@deploy/kiosk-url.sh hmr
	@echo "▸ Vite läuft auf dem Mac; Ctrl-C schaltet den Kiosk zurück auf prod."
	@trap 'deploy/kiosk-url.sh prod' EXIT; cd ui && npm run dev -- --host

deploy: ## Release: Pi zieht aus Git und baut nativ (optimiert)
	@deploy/release.sh

push: ## Committen+pushen und anschließend Release deployen
	@git push && deploy/release.sh

logs: ## Server-Log des Pi live mitlesen
	@deploy/logs.sh

status: ## Zustand der Dienste auf dem Pi
	@deploy/logs.sh --status

kiosk-restart: ## Chromium auf dem Pi neu starten
	@deploy/kiosk-url.sh prod

kiosk-url: ## Kiosk auf eine URL schicken:  make kiosk-url URL=http://…
	@deploy/kiosk-url.sh "$(URL)"

kiosk-rotate: ## Kiosk-Anzeige drehen:  make kiosk-rotate DEG=0|90|180|270
	@deploy/kiosk-rotate.sh "$(DEG)"

shell: ## SSH-Shell auf dem Pi
	@. deploy/config.env && ssh $$PI_USER@$$PI_HOST
