{
  "targets": [
    {
      "target_name": "windows_file_ops",
      "sources": ["src/windows_file_ops.cc"],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions!": ["-std:c++20"],
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
