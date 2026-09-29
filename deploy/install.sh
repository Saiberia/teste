#!/usr/bin/env bash
# Recapper: установка / обновление на VPS (Ubuntu/Debian). Повторный запуск = обновление.
#   curl -fsSL https://raw.githubusercontent.com/Saiberia/teste/claude/cloud-mode-claude-code-g6q3pn/deploy/install.sh | sudo bash
set -euo pipefail
REPO="${RECAPPER_REPO:-https://github.com/Saiberia/teste.git}"
BRANCH="${RECAPPER_BRANCH:-claude/cloud-mode-claude-code-g6q3pn}"
DIR=/opt/recapper

[ "$(id -u)" = 0 ] || { echo "Запустите от root: ... | sudo bash"; exit 1; }
echo "==> Recapper: подготовка сервера"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git curl ca-certificates; }
command -v docker >/dev/null || { echo "==> Ставлю Docker"; curl -fsSL https://get.docker.com | sh; }
systemctl enable --now docker >/dev/null 2>&1 || true

if [ -d "$DIR/.git" ]; then
  echo "==> Обновляю код"
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  echo "==> Скачиваю код"
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/deploy"

if [ ! -f .env ]; then
  IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  DOMAIN="${RECAPPER_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
  printf 'RECAPPER_API_TOKEN=%s\nRECAPPER_DOMAIN=%s\n' "$TOKEN" "$DOMAIN" > .env
  chmod 600 .env
fi
set -a; . ./.env; set +a

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

echo "==> Собираю и запускаю (первый раз 3–10 минут)"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo
echo "============================================================"
echo " Recapper работает:"
echo "   https://${RECAPPER_DOMAIN}/?token=${RECAPPER_API_TOKEN}"
echo " Токен (для расширения):  ${RECAPPER_API_TOKEN}"
echo " Сохранён в ${DIR}/deploy/.env. Логи: cd ${DIR}/deploy && docker compose logs -f"
echo "============================================================"
