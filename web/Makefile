# Managing the web/ development processes. The port comes from .env (copy .env.example).
-include .env
export

DEV_PORT ?= 5173
UP_PORT  ?= 8080

.PHONY: dev up down logs kill pkg

pkg:   ## rebuild the three-slicer package dist (viewer/components bundles)
	cd .. && npm run build -w three-slicer

dev: pkg  ## vite dev server (DEV_PORT; kills whatever holds the port first)
	@$(MAKE) --no-print-directory kill PORT=$(DEV_PORT)
	cd viewer && npx vite --port $(DEV_PORT) --strictPort

up:    ## start with docker compose (UP_PORT)
	@$(MAKE) --no-print-directory kill PORT=$(UP_PORT)
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

kill:  ## kill the process holding PORT=n
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then echo "port $(PORT) in use -> kill $$pids"; kill -9 $$pids; fi
