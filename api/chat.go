package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
)

// RequestBody matches the JSON coming from the frontend
type RequestBody struct {
	History      []HistoryMessage `json:"history"`
	UserInput    string           `json:"userInput"`
	IsCorrection bool             `json:"isCorrection"`
	CorrectThing string           `json:"correctThing"`
}

type HistoryMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// ResponseBody matches what the frontend expects back
type ResponseBody struct {
	Question    string `json:"question"`
	IsGuess     bool   `json:"isGuess"`
	FinalAnswer string `json:"finalAnswer,omitempty"`
}

// OpenRouter specific structs
type ORMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ORRequest struct {
	Model    string      `json:"model"`
	Messages []ORMessage `json:"messages"`
}

type ORResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("OPENROUTER_API_KEY")
	if apiKey == "" {
		sendError(w, "SYSTEM ERROR: Missing OPENROUTER_API_KEY in .env file.")
		return
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		sendError(w, "SYSTEM ERROR: Failed to parse request.")
		return
	}

	systemInstruction := `You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept.
Rules:
1. Ask ONE question at a time. The user will answer: Yes, No, Maybe, or Don't Know.
2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
4. Absolutely NO markdown tags, NO conversational filler, ONLY output valid JSON.`

	// 1. Build the OpenRouter Messages Array
	var messages []ORMessage
	messages = append(messages, ORMessage{Role: "system", Content: systemInstruction})

	// OpenRouter uses "assistant" instead of "model" for the bot's history
	for _, msg := range reqBody.History {
		role := "user"
		if msg.Role == "model" {
			role = "assistant"
		}
		messages = append(messages, ORMessage{Role: role, Content: msg.Text})
	}

	// 2. Handle Correction/Learning Mode
	if reqBody.IsCorrection {
		historyJSON, _ := json.Marshal(reqBody.History)
		learningPrompt := "I was thinking of \"" + reqBody.CorrectThing + "\". Review our history: " + string(historyJSON) + ". Learn from this mistake. Reply with strict JSON: {\"question\": \"Got it! I will remember that. Let's play again!\"}"
		
		messages = append(messages, ORMessage{Role: "user", Content: learningPrompt})
		
		_, err := callOpenRouter(apiKey, messages)
		if err != nil {
			sendError(w, "SERVER ERROR: "+err.Error())
			return
		}
		
		json.NewEncoder(w).Encode(map[string]bool{"reset": true})
		return
	}

	// 3. Normal Gameplay
	input := reqBody.UserInput
	if input == "" {
		input = "Let's start!"
	}
	messages = append(messages, ORMessage{Role: "user", Content: input})

	// Make the API Call
	responseText, err := callOpenRouter(apiKey, messages)
	if err != nil {
		sendError(w, "SERVER ERROR: "+err.Error())
		return
	}

	// Clean JSON and send to frontend
	cleanJSON := cleanMarkdown(responseText)
	w.Write([]byte(cleanJSON))
}

// Function to handle the raw HTTP request to OpenRouter
func callOpenRouter(apiKey string, messages []ORMessage) (string, error) {
	// We are using the 100% free Llama 3.1 model
	reqBody := ORRequest{
		Model:    "meta-llama/llama-3.1-8b-instruct:free",
		Messages: messages,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewBuffer(jsonData))
	if err != nil {
		return "", err
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	// Optional but recommended by OpenRouter
	req.Header.Set("HTTP-Referer", "https://github.com/avdhez/Ankinator-with-gemini-api") 
	req.Header.Set("X-Title", "Mystic Node Bot")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)

	var orResp ORResponse
	if err := json.Unmarshal(bodyBytes, &orResp); err != nil {
		return "", err
	}

	if len(orResp.Choices) > 0 {
		return orResp.Choices[0].Message.Content, nil
	}

	return "", nil
}

// Helper to strip markdown code blocks from Llama's response
func cleanMarkdown(input string) string {
	input = strings.TrimSpace(input)
	input = strings.TrimPrefix(input, "```json")
	input = strings.TrimPrefix(input, "```")
	input = strings.TrimSuffix(input, "```")
	return strings.TrimSpace(input)
}

// Helper to send standard errors to the frontend
func sendError(w http.ResponseWriter, msg string) {
	json.NewEncoder(w).Encode(ResponseBody{
		Question: msg,
		IsGuess:  false,
	})
}