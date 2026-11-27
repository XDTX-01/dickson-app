{
  "targets": [
    {
      "target_name": "protect",
      "sources": ["protect.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": "1",
                "AdditionalOptions": ["/EHsc"]
              }
            }
          }
        ]
      ]
    }
  ]
}
