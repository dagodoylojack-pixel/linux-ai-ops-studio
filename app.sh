#!/bin/bash

# Script para gestionar la aplicación localmente en Linux/Mac
# Uso: ./app.sh [start|stop|status|restart]

set -e

PORT=3005
SERVER_FILE="server.ts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Funciones auxiliares
get_pid() {
    lsof -ti :$PORT 2>/dev/null || echo ""
}

ensure_dependencies() {
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}⚠️  Installing dependencies...${NC}"
        npm install --quiet
        echo -e "${GREEN}✓ Dependencies installed${NC}"
    fi
}

start_app() {
    echo -e "\n${CYAN}▶ Starting application...${NC}"
    
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "${GREEN}✓ Application already running (PID: $PID)${NC}"
        echo -e "${CYAN}  URL: http://localhost:$PORT${NC}"
        return 0
    fi

    ensure_dependencies

    npx --no-install tsx $SERVER_FILE &
    APP_PID=$!
    sleep 2

    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "${GREEN}✓ Application started successfully (PID: $PID)${NC}"
        echo -e "${CYAN}  URL: http://localhost:$PORT${NC}"
    else
        echo -e "${RED}✗ Failed to start application${NC}"
        exit 1
    fi
}

stop_app() {
    echo -e "\n${YELLOW}⊙ Stopping application...${NC}"
    
    PID=$(get_pid)
    if [ -z "$PID" ]; then
        echo -e "${YELLOW}✓ Application is not running${NC}"
        return 0
    fi

    kill -TERM $PID 2>/dev/null || kill -KILL $PID 2>/dev/null || true
    sleep 1
    echo -e "${GREEN}✓ Application stopped (PID: $PID)${NC}"
}

show_status() {
    echo -e "\n${CYAN}📊 Application Status${NC}"
    echo -e "${CYAN}$(printf '%-50s' | tr ' ' '-')${NC}"
    
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "${GREEN}✓ Running on port $PORT (PID: $PID)${NC}"
        echo -e "${CYAN}  URL: http://localhost:$PORT${NC}"
    else
        echo -e "${YELLOW}✗ Not running on port $PORT${NC}"
    fi

    echo -e "\n${CYAN}📦 Dependencies${NC}"
    echo -e "${CYAN}$(printf '%-50s' | tr ' ' '-')${NC}"
    if [ -d "node_modules" ]; then
        echo -e "${GREEN}✓ Installed${NC}"
    else
        echo -e "${RED}✗ Not installed${NC}"
    fi
    echo ""
}

# Main
case "${1,,}" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    status)
        show_status
        ;;
    restart)
        stop_app
        sleep 1
        start_app
        ;;
    *)
        echo ""
        echo "  Linux AI Ops Studio - Application Manager"
        echo "  =========================================="
        echo ""
        echo "  Uso: ./app.sh [comando]"
        echo ""
        echo "  Comandos:"
        echo "    start   - Inicia la aplicación en puerto 3005"
        echo "    stop    - Detiene la aplicación"
        echo "    status  - Muestra el estado de la aplicación"
        echo "    restart - Reinicia la aplicación"
        echo ""
        exit 1
        ;;
esac
