# web/ 개발 프로세스 관리. 포트는 .env 로 지정 (.env.example 복사).
-include .env
export

DEV_PORT ?= 5173
UP_PORT  ?= 8080

.PHONY: dev up down logs kill

dev:   ## vite dev 서버 (DEV_PORT, 점유 중이면 kill 후 기동)
	@$(MAKE) --no-print-directory kill PORT=$(DEV_PORT)
	cd viewer && npx vite --port $(DEV_PORT) --strictPort

up:    ## docker compose 로 기동 (UP_PORT)
	@$(MAKE) --no-print-directory kill PORT=$(UP_PORT)
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

kill:  ## PORT=n 을 점유한 프로세스 종료
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then echo "포트 $(PORT) 점유 중 → kill $$pids"; kill -9 $$pids; fi
