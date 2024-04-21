# Refactoring Participant

A Co-Pilot extension that contributes a refactoring support. 

### Menu
It contributes a 'Suggest Refactoring' command that makes refactoring suggestions for the current selection.

<img src="images/suggest-command.png" width="500">

When there is no selection in the editor a quick pick dialog allows to select a range to be refactored.

<img src="images/scope-picker.png" width="400">

### Response
The suggestions appears in the Chat view with buttons to: 
- preview and apply the suggestions.
- request another suggestion.

<img src="images/preview-changes.png" width="300">

The changes can be previewed in a diff editor which provides a command to apply the changes.

<img src="images/apply-changes.png" width="400">

### Chat Commands
In addition, the extension contributes a several '/' commands to the Chat view which can request for specific refactoring suggestions.

<img src="images/chat-commands.png" width="300">
