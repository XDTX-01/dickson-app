{
  "targets": [
    {
      "target_name": "protect",
      "sources": ["protect.cc"],
      "include_dirs": [
        "<(module_root_dir)/../node_modules/node-addon-api"
      ],
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
                "AdditionalOptions": [
                  "/EHsc",
                  "/I$(ProjectDir)..\\..\\node_modules\\node-addon-api"
                ]
              }
            }
          }
        ]
      ]
    }
  ]
}
