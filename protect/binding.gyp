{
  "targets": [
    {
      "target_name": "protect",
      "sources": ["protect.cc"],
      "include_dirs": ["<!(node -e \"const p=require('path');console.log(p.join(__dirname,'..','node_modules','node-addon-api'))\")"],
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
