#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <LittleFS.h>
HardwareSerial Serial(0);
TwoWire Wire;
WiFiClass WiFi;
LittleFSClass LittleFS;
std::deque<HttpReply> httpQueue;
std::deque<std::string> httpCalls;
std::map<std::string, std::string> littleFsFiles;
EspClass ESP;
bool (*serialWriteHook)(int, const uint8_t *, size_t, std::deque<uint8_t> &) = nullptr;
void (*screenHook)(const std::string &) = nullptr;
