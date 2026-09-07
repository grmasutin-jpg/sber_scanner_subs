import os
import time
import uuid
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv

# Загружаем переменные из файла .env
load_dotenv()

app = FastAPI(title="Backend for GigaChat")

# --- Конфигурация ---
CLIENT_ID = os.getenv("GIGACHAT_CLIENT_ID")
SECRET_KEY = os.getenv("GIGACHAT_SECRET_KEY")
MODEL_NAME = os.getenv("MODEL", "GigaChat-3-Ultra")
# Доступные модели: GigaChat-2, GigaChat-2-Max, GigaChat-2-Pro, GigaChat-3-Lightning, GigaChat-3-Pro, GigaChat-3-Ultra
TOKEN_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
API_URL = "https://api.giga.chat/v1/chat/completions"
# Сертификат Сбера самоподписанный — отключаем проверку SSL для OAuth
GIGACHAT_VERIFY_SSL = os.getenv("GIGACHAT_VERIFY_SSL", "false").lower() in ("1", "true", "yes", "on")
# SECRET_KEY — это голый секрет. Кодируем client_id:secret в base64 для Basic auth.
import base64
BASIC_CREDENTIAL = base64.b64encode(f"{CLIENT_ID}:{SECRET_KEY}".encode()).decode()

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: list[Message]
    temperature: float = 0.7
    max_tokens: int = 1000

# Кэшируем токен, чтобы не запрашивать его при каждом сообщении
token_cache = {"access_token": os.getenv("GIGACHAT_ACCESS_TOKEN") or None, "expires_at": 0}

async def get_access_token():
    """Получает или обновляет Bearer Token"""
    # Если есть готовый токен в .env — используем его (для тестирования)
    env_token = os.getenv("GIGACHAT_ACCESS_TOKEN")
    print(f"[DEBUG] Token from env: {'YES (' + str(len(env_token)) + ' chars)' if env_token else 'NO'}")
    if env_token:
        return env_token

    current_time = time.time()
    if token_cache["access_token"] and current_time < token_cache["expires_at"]:
        return token_cache["access_token"]

    # SECRET_KEY — это голый секрет. Кодируем client_id:secret в base64 для Basic auth.
    async with httpx.AsyncClient(timeout=30.0, verify=GIGACHAT_VERIFY_SSL) as client:
        response = await client.post(TOKEN_URL,
            data={'grant_type': 'client_credentials', 'scope': 'GIGACHAT_API_PERS'},
            headers={
                'Authorization': f'Basic {BASIC_CREDENTIAL}',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'RqUID': str(uuid.uuid4())
            }
        )
        response.raise_for_status()
        result = response.json()

        # Сбер возвращает время жизни в секундах
        expires_in = result.get('expires_in', 3600) - 60  # Запас 60 секунд
        token_cache["access_token"] = result['access_token']
        token_cache["expires_at"] = current_time + expires_in

        return result['access_token']

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Принимает сообщение от пользователя через POST-запрос 
    и перенаправляет его в GigaChat.
    """
    try:
        access_token = await get_access_token()
        
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-client-id": CLIENT_ID
        }
        
        payload = {
            "model": MODEL_NAME,
            "messages": [msg.dict() for msg in request.messages],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "stream": False
        }

        # Используем раздельные таймауты: 10с на подключение, 90с на чтение
        timeout = httpx.Timeout(90.0, connect=10.0, read=90.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout, verify=GIGACHAT_VERIFY_SSL) as client:
            api_response = await client.post(API_URL, json=payload, headers=headers)
            api_response.raise_for_status()
            
            giga_data = api_response.json()
            
            # Извлекаем текст ответа
            choices = giga_data.get("choices", [])
            if not choices:
                raise HTTPException(status_code=500, detail="Empty response from AI")
                
            assistant_message = choices[0]["message"]["content"]
            
            return {
                "role": "assistant",
                "content": assistant_message
            }
            
    except httpx.HTTPStatusError as e:
        error_detail = e.response.text
        raise HTTPException(status_code=e.response.status_code, detail=f"GigaChat Error: {error_detail}")
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=504, detail=f"GigaChat API timeout: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)